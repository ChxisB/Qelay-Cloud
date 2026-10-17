import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, expireLease, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('tick: the composed pass', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000, ringWindowMs: 10_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  const tick = (budget: Partial<TickBudget> = {}) => t.store.tick({ ...BUDGET, ...budget });

  test('an empty store: nothing done, no rings, no more work', async () => {
    const { stepMs, ...report } = await tick();
    expect(report).toEqual({
      recovered: 0,
      promoted: 0,
      cronFired: 0,
      expired: 0,
      rings: [],
      moreWork: false,
    });
    // Every step ran, each timed in whole milliseconds, for the telemetry of task 20.
    expect(Object.keys(stepMs ?? {}).sort()).toEqual([
      'completions',
      'crons',
      'events',
      'expire',
      'promote',
      'recover',
      'retention',
      'ringQuery',
    ]);
    expect(Object.values(stepMs ?? {}).every((ms) => Number.isInteger(ms) && ms >= 0)).toBe(true);
  });

  test('does every step once, and rings what they made claimable', async () => {
    const dead = await claimOne(t, { attempts: 3, backoff: 0 });
    const [due] = await enqueueN(t.store, 1, { delay: 1_000 });
    const [stale] = await enqueueN(t.store, 1, {}, 'beta');
    const [ttl] = await enqueueN(t.store, 1, {}, 'beta');
    await t.fresh.sql`UPDATE qcloud_jobs SET ttl = 500 WHERE id = ${ttl!}`;
    expireLease(t, dead, 1_000);

    const report = await tick();
    expect(report).toMatchObject({ recovered: 1, promoted: 1, expired: 1, moreWork: false });
    expect((await readJob(t, due!))?.state).toBe('waiting');
    expect(await readJob(t, ttl!)).toBeUndefined();
    expect(report.rings.map((ring) => ring.bell.jobId).sort()).toEqual(
      [dead.id, due!, stale!].sort()
    );
    expect(report.rings.every((ring) => ring.dueInMs === 0)).toBe(true);
  });

  test('rings are not recorded by the tick: until markRung, the next tick returns them again', async () => {
    const [id] = await enqueueN(t.store, 1);
    const first = await tick();
    expect(first.rings).toHaveLength(1);
    expect((await readJob(t, id!))?.rung_at).toBeNull();
    expect((await tick()).rings).toEqual(first.rings);
    await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
    expect((await tick()).rings).toEqual([]);
  });

  test('a recovered job comes back as one ring, not two', async () => {
    const dead = await claimOne(t, { attempts: 3, backoff: 0 });
    expireLease(t, dead, 1);
    const { rings } = await tick();
    expect(rings.map((ring) => ring.bell.jobId)).toEqual([dead.id]);
  });

  test('a recovered job whose backoff fits the window is rung with the wait', async () => {
    const dead = await claimOne(t, { attempts: 3, backoff: 4_000 });
    expireLease(t, dead, 1);
    const { rings } = await tick();
    expect(rings).toMatchObject([{ bell: { jobId: dead.id }, dueInMs: 4_000 }]);
  });

  describe('the budget', () => {
    test('maxItems caps each step and reports more work', async () => {
      await enqueueN(t.store, 5, { delay: 100 });
      t.clock.advance(100);
      const first = await tick({ maxItems: 2 });
      expect(first).toMatchObject({ promoted: 2, moreWork: true });
      expect(await tick({ maxItems: 2 })).toMatchObject({ promoted: 2, moreWork: true });
      expect(await tick({ maxItems: 2 })).toMatchObject({ promoted: 1, moreWork: false });
    });

    test('a spent maxDurationMs skips the housekeeping but not recovery or the rings', async () => {
      const dead = await claimOne(t, { attempts: 3, backoff: 0 });
      const [due] = await enqueueN(t.store, 1, { delay: 100 });
      expireLease(t, dead, 1);
      const report = await tick({ maxDurationMs: 0 });
      expect(report).toMatchObject({ recovered: 1, promoted: 0, expired: 0, moreWork: true });
      expect(report.rings.map((ring) => ring.bell.jobId).sort()).toEqual([dead.id, due!].sort());
      expect((await readJob(t, due!))?.state).toBe('delayed');
      // A skipped step has no timing.
      expect(Object.keys(report.stepMs ?? {}).sort()).toEqual(['recover', 'ringQuery']);
    });

    test('the cap on rings per queue is not more work', async () => {
      await enqueueN(t.store, 10);
      const report = await tick({ maxRingsPerQueue: 3 });
      expect(report.rings).toHaveLength(3);
      expect(report.moreWork).toBe(false);
    });

    test('ring parameters reach the query: threshold, grace and window', async () => {
      const [id] = await enqueueN(t.store, 1);
      expect((await tick({ ringGraceMs: 1_000 })).rings).toEqual([]);
      t.clock.advance(1_000);
      expect((await tick({ ringGraceMs: 1_000 })).rings).toHaveLength(1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      t.clock.advance(2_000);
      expect((await tick({ reRingAfterMs: 3_000 })).rings).toEqual([]);
      expect((await tick({ reRingAfterMs: 2_000 })).rings).toHaveLength(1);
      await enqueueN(t.store, 1, { delay: 8_000 });
      expect((await tick({ ringWindowMs: 5_000 })).rings).toEqual([]);
      expect((await tick({ ringWindowMs: 8_000 })).rings).toMatchObject([{ dueInMs: 8_000 }]);
    });

    test.each([
      ['maxItems', { maxItems: 0 }],
      ['maxItems', { maxItems: 1.5 }],
      ['maxRingsPerQueue', { maxRingsPerQueue: 0 }],
      ['maxDurationMs', { maxDurationMs: -1 }],
      ['maxDurationMs', { maxDurationMs: Number.NaN }],
    ])('rejects an unusable %s before touching anything', async (name, budget) => {
      const [id] = await enqueueN(t.store, 1, { delay: 1 });
      t.clock.advance(1);
      const error = await tick(budget).catch((caught) => caught);
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect(error.message).toContain(name);
      expect((await readJob(t, id!))?.state).toBe('delayed');
    });
  });

  test('deletes DLQ entries older than their queue maxAge', async () => {
    const job = await claimOne(t, { attempts: 1 });
    await t.store.fail(job.lease, { message: 'x', unrecoverable: true });
    t.clock.advance(7 * 86_400_000 + 1);
    const report = await tick();
    expect(report.moreWork).toBe(false);
    expect(await readJob(t, job.id)).toBeUndefined();
  });

  test('four ticks at once do each piece of work exactly once', async () => {
    const dead = await Promise.all([1, 2, 3].map(() => claimOne(t, { attempts: 3, backoff: 0 })));
    await enqueueN(t.store, 40, { delay: 100 });
    t.clock.advance(31_000);
    const stores = [t.store, t.another(), t.another(), t.another()];
    const reports = await Promise.all(stores.map((store) => store.tick(BUDGET)));
    expect(reports.reduce((sum, report) => sum + report.recovered, 0)).toBe(dead.length);
    expect(reports.reduce((sum, report) => sum + report.promoted, 0)).toBe(40);
    const states = await t.fresh.sql<{ attempts: number; version: string }[]>`
      SELECT attempts, version FROM qcloud_jobs WHERE id = ANY(${t.fresh.sql.array(
        dead.map((job) => job.id),
        'TEXT'
      )})`;
    expect(states.every((row) => row.attempts === 1)).toBe(true);
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(40);
  });
});
