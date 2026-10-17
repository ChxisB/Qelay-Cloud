import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { createMsgpackCodec } from '../src/codec';
import type { CronSpec } from '../src/cron/types';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const MINUTE = 60_000;
const EVERY_MINUTE: CronSpec = { name: 'tick', queue: 'cq', repeatEvery: MINUTE };

describeDb('crons: firing', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_crons, qcloud_workers`;
  });

  const jobsOf = (queue = 'cq') =>
    t.store.listJobs({ queue, limit: 1000 }).then((page) => page.items);
  const cron = async (name = 'tick') => (await t.store.crons.get(name))!;

  test('nothing is due before next_run, and the due scan says so', async () => {
    await t.store.crons.upsert(EVERY_MINUTE);
    t.clock.advance(MINUTE - 1);
    expect(await t.store.crons.claimDue()).toEqual({
      fired: 0,
      skipped: 0,
      more: false,
      rings: [],
    });
    expect(await jobsOf()).toEqual([]);
  });

  test('a due cron creates one job from its definition, and advances', async () => {
    await t.store.crons.upsert({
      ...EVERY_MINUTE,
      jobName: 'send',
      data: { to: 'ops' },
      priority: 0,
      jobOptions: { attempts: 5 },
    });
    t.clock.advance(MINUTE);
    const firing = await t.store.crons.claimDue();
    expect(firing).toMatchObject({ fired: 1, skipped: 0, more: false });
    const [job] = await jobsOf();
    expect(job).toMatchObject({
      queue: 'cq',
      name: 'send',
      data: { to: 'ops' },
      state: 'waiting',
      maxAttempts: 5,
    });
    expect(await cron()).toMatchObject({ executions: 1, nextRun: START + 2 * MINUTE });
    expect(firing.rings).toMatchObject([{ bell: { jobId: job!.id }, dueInMs: 0 }]);
  });

  test('a cron with a priority makes a prioritized job', async () => {
    await t.store.crons.upsert({ ...EVERY_MINUTE, priority: 3, immediately: true });
    await t.store.crons.claimDue();
    expect((await jobsOf())[0]).toMatchObject({ state: 'prioritized', priority: 3 });
  });

  test('a delay in the template delays the job; it is rung only inside the ring window', async () => {
    await t.store.crons.upsert({
      ...EVERY_MINUTE,
      jobOptions: { delay: 4_000 },
      immediately: true,
    });
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1, rings: [] });
    expect((await jobsOf())[0]).toMatchObject({ state: 'delayed', runAt: START + 4_000 });

    const windowed = t.another({ ringWindowMs: 10_000 });
    await t.store.crons.upsert({
      ...EVERY_MINUTE,
      name: 'w',
      queue: 'wq',
      jobOptions: { delay: 4_000 },
      immediately: true,
    });
    const { rings } = await windowed.crons.claimDue();
    expect(rings).toMatchObject([{ dueInMs: 4_000 }]);
  });

  test('the same occurrence is not fired twice', async () => {
    await t.store.crons.upsert({ ...EVERY_MINUTE, preventOverlap: false });
    t.clock.advance(MINUTE);
    await t.store.crons.claimDue();
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0 });
    expect(await jobsOf()).toHaveLength(1);
  });

  test('an interval keeps its cadence when the tick is a little late', async () => {
    await t.store.crons.upsert({ ...EVERY_MINUTE, preventOverlap: false });
    t.clock.advance(MINUTE + 5_000);
    await t.store.crons.claimDue();
    expect((await cron()).nextRun).toBe(START + 2 * MINUTE);
  });

  test('an interval that missed several occurrences fires once and restarts from now', async () => {
    await t.store.crons.upsert({ ...EVERY_MINUTE, preventOverlap: false });
    t.clock.advance(10 * MINUTE + 5_000);
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
    expect(await cron()).toMatchObject({ executions: 1, nextRun: START + 11 * MINUTE + 5_000 });
    expect(await jobsOf()).toHaveLength(1);
  });

  test('a schedule that missed occurrences fires once and continues from now', async () => {
    await t.store.crons.upsert({
      name: 'min',
      queue: 'cq',
      schedule: '* * * * *',
      preventOverlap: false,
    });
    t.clock.advance(30 * MINUTE + 10_000);
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
    expect(await jobsOf()).toHaveLength(1);
    const next = (await cron('min')).nextRun;
    expect(next).toBeGreaterThan(t.clock.now());
    expect(next - t.clock.now()).toBeLessThanOrEqual(MINUTE);
  });

  test('immediately fires a new cron at the next claim, then follows the timing', async () => {
    await t.store.crons.upsert({ ...EVERY_MINUTE, immediately: true });
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
    expect(await cron()).toMatchObject({ executions: 1, nextRun: START + MINUTE });
  });

  describe('maxLimit', () => {
    test('stops after that many executions, and never fires again', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, maxLimit: 2, preventOverlap: false });
      for (let n = 0; n < 5; n++) {
        t.clock.advance(MINUTE);
        await t.store.crons.claimDue();
      }
      expect(await jobsOf()).toHaveLength(2);
      expect(await cron()).toMatchObject({ executions: 2, maxLimit: 2 });
    });

    test('a skipped occurrence does not use one up', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, maxLimit: 2 });
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0, skipped: 1 });
      expect((await cron()).executions).toBe(1);
    });

    test('a cron with no further occurrence is closed by the firing that found none', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, preventOverlap: false });
      // A schedule can only run out through a stored definition the validator would refuse today.
      const [{ payload }] = await t.fresh.sql<{ payload: Uint8Array }[]>`
        SELECT payload FROM qcloud_crons WHERE name = 'tick'`;
      const codec = createMsgpackCodec();
      const envelope = codec.decode(payload) as Record<string, unknown>;
      await t.fresh.sql`
        UPDATE qcloud_crons SET next_run = ${START},
          payload = ${codec.encode({ ...envelope, repeatEvery: null, schedule: '0 0 31 2 *' })}`;
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
      expect(await cron()).toMatchObject({ executions: 1, maxLimit: 1 });
      t.clock.advance(365 * 86_400_000);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0, skipped: 0 });
      expect(await jobsOf()).toHaveLength(1);
    });
  });

  describe('overlap and deduplication', () => {
    test('preventOverlap skips, uncounted, while the previous job is live', async () => {
      await t.store.crons.upsert(EVERY_MINUTE);
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0, skipped: 1, rings: [] });
      expect(await cron()).toMatchObject({ executions: 1, nextRun: START + 3 * MINUTE });
      expect(await jobsOf()).toHaveLength(1);
    });

    test('and fires again once the previous job is finished', async () => {
      await t.store.crons.upsert(EVERY_MINUTE);
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      const [job] = await t.store.claim('cq', 'w', 1);
      await t.store.complete(job!.lease, null);
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1, skipped: 0 });
      expect(await jobsOf()).toHaveLength(2);
    });

    test('without preventOverlap and without a key, every occurrence makes a job', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, preventOverlap: false });
      for (let n = 0; n < 3; n++) {
        t.clock.advance(MINUTE);
        await t.store.crons.claimDue();
      }
      expect(await jobsOf()).toHaveLength(3);
      expect((await cron()).executions).toBe(3);
    });

    test('with a uniqueKey and no preventOverlap, a duplicate still counts as an occurrence', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, uniqueKey: 'k', preventOverlap: false });
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1, skipped: 0, rings: [] });
      expect(await jobsOf()).toHaveLength(1);
      expect((await cron()).executions).toBe(2);
    });

    test('two crons sharing a uniqueKey deduplicate against each other', async () => {
      await t.store.crons.upsert({
        ...EVERY_MINUTE,
        name: 'a',
        uniqueKey: 'shared',
        preventOverlap: false,
      });
      await t.store.crons.upsert({
        ...EVERY_MINUTE,
        name: 'b',
        uniqueKey: 'shared',
        preventOverlap: false,
      });
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 2 });
      expect(await jobsOf()).toHaveLength(1);
    });

    test('the dedup options reach the spawned job: replace swaps the payload', async () => {
      await t.store.crons.upsert({
        ...EVERY_MINUTE,
        uniqueKey: 'k',
        preventOverlap: false,
        data: 'first',
        dedup: { replace: true },
      });
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      await t.store.crons.upsert({
        ...EVERY_MINUTE,
        uniqueKey: 'k',
        preventOverlap: false,
        data: 'second',
        dedup: { replace: true },
      });
      t.clock.advance(MINUTE);
      await t.store.crons.claimDue();
      const jobs = await jobsOf();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toBe('second');
    });
  });

  describe('the limit and the rings', () => {
    test('limit caps one pass, reports more, and the next pass takes the rest', async () => {
      for (let n = 0; n < 5; n++) {
        await t.store.crons.upsert({ ...EVERY_MINUTE, name: `c${n}`, immediately: true });
      }
      expect(await t.store.crons.claimDue(2)).toMatchObject({ fired: 2, more: true });
      expect(await t.store.crons.claimDue(2)).toMatchObject({ fired: 2, more: true });
      expect(await t.store.crons.claimDue(2)).toMatchObject({ fired: 1, more: false });
      expect(await jobsOf()).toHaveLength(5);
    });

    test('the oldest due crons go first', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'late', repeatEvery: 3 * MINUTE });
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'early', repeatEvery: MINUTE });
      t.clock.advance(3 * MINUTE);
      await t.store.crons.claimDue(1);
      expect((await cron('early')).executions).toBe(1);
      expect((await cron('late')).executions).toBe(0);
    });

    test.each([0, -1, 1.5, Number.NaN])('rejects an unusable limit %p', async (limit) => {
      await expect(t.store.crons.claimDue(limit)).rejects.toBeInstanceOf(UnsupportedOptionError);
    });

    test('a ring is returned for each job created, not for a duplicate', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'a', immediately: true });
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'b', queue: 'other', immediately: true });
      const { rings } = await t.store.crons.claimDue();
      expect(rings).toHaveLength(2);
      expect(new Set(rings.map((ring) => ring.bell.jobId)).size).toBe(2);
    });
  });
});
