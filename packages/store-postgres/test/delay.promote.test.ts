import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('delay: promoting delayed jobs that came due', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  const stateOf = async (id: string) => (await readJob(t, id))?.state;

  test('moves a due delayed job to waiting, keeping its run_at and its bell', async () => {
    const [id] = await enqueueN(t.store, 1, { delay: 1_000 });
    await t.store.markRung([{ jobId: id!, deliverAfterMs: 1_000 }]);
    t.clock.advance(1_000);
    log.events.length = 0;
    expect(await t.store.promoteDue()).toEqual({ promoted: 1, more: false });
    expect(await readJob(t, id!)).toMatchObject({
      state: 'waiting',
      run_at: String(START + 1_000),
      rung_at: String(START + 1_000),
      version: '1',
    });
    expect(log.events).toEqual([{ type: 'promoted', queue: 'q', jobId: id!, state: 'waiting' }]);
  });

  test('a delayed job with a priority becomes prioritized', async () => {
    const [id] = await enqueueN(t.store, 1, { delay: 1_000, priority: 5 });
    t.clock.advance(1_000);
    await t.store.promoteDue();
    expect(await stateOf(id!)).toBe('prioritized');
  });

  test('leaves a job whose time has not come, and one that is not delayed', async () => {
    const [later] = await enqueueN(t.store, 1, { delay: 1_000 });
    const [now] = await enqueueN(t.store, 1);
    log.events.length = 0;
    t.clock.advance(999);
    expect(await t.store.promoteDue()).toEqual({ promoted: 0, more: false });
    expect(await stateOf(later!)).toBe('delayed');
    expect(await stateOf(now!)).toBe('waiting');
    expect(log.events).toEqual([]);
  });

  test('is idempotent: a second pass finds nothing', async () => {
    await enqueueN(t.store, 3, { delay: 500 });
    t.clock.advance(500);
    expect((await t.store.promoteDue()).promoted).toBe(3);
    log.events.length = 0;
    expect(await t.store.promoteDue()).toEqual({ promoted: 0, more: false });
    expect(log.events).toEqual([]);
  });

  test('promotes the oldest due time first, across queues, and reports when there is more', async () => {
    const early = await enqueueN(t.store, 2, { delay: 100 }, 'alpha');
    const middle = await enqueueN(t.store, 2, { delay: 200 }, 'beta');
    const late = await enqueueN(t.store, 2, { delay: 300 }, 'alpha');
    t.clock.advance(1_000);
    expect(await t.store.promoteDue(3)).toEqual({ promoted: 3, more: true });
    expect(await Promise.all([...early, ...middle].map(stateOf))).toEqual([
      'waiting',
      'waiting',
      'waiting',
      'delayed',
    ]);
    expect(await t.store.promoteDue(3)).toEqual({ promoted: 3, more: false });
    expect(await Promise.all(late.map(stateOf))).toEqual(['waiting', 'waiting']);
  });

  test('a delayed job that is due is claimable before and after it is promoted', async () => {
    const [id] = await enqueueN(t.store, 1, { delay: 100 });
    t.clock.advance(100);
    expect((await t.store.getJob(id!))?.state).toBe('waiting');
    await t.store.promoteDue();
    expect((await t.store.getJob(id!))?.state).toBe('waiting');
    expect((await t.store.claim('q', 'w', 1)).map((job) => job.id)).toEqual([id!]);
  });

  test('skips a row another transaction holds, and takes it on the next pass', async () => {
    const ids = await enqueueN(t.store, 3, { delay: 100 });
    t.clock.advance(100);
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const holder = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT id FROM qcloud_jobs WHERE id = ${ids[1]!} FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const report = await t.store.promoteDue();
    release.resolve();
    await holder;
    expect(report.promoted).toBe(2);
    expect(await stateOf(ids[1]!)).toBe('delayed');
    expect((await t.store.promoteDue()).promoted).toBe(1);
    expect(await stateOf(ids[1]!)).toBe('waiting');
  });

  test('four passes at once promote every job exactly once', async () => {
    await enqueueN(t.store, 120, { delay: 100 });
    t.clock.advance(100);
    log.events.length = 0;
    const stores = [t.store, t.another(), t.another(), t.another()];
    const reports = await Promise.all(stores.map((store) => store.promoteDue(50)));
    let promoted = reports.reduce((sum, report) => sum + report.promoted, 0);
    for (let pass = await t.store.promoteDue(50); pass.promoted > 0;) {
      promoted += pass.promoted;
      pass = await t.store.promoteDue(50);
    }
    const states = await t.fresh.sql<{ state: string; version: string }[]>`
      SELECT state, version FROM qcloud_jobs`;
    expect(states.every((row) => row.state === 'waiting' && row.version === '1')).toBe(true);
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(120);
    expect(new Set(log.events.map((event) => event.jobId)).size).toBe(120);
    expect(promoted).toBe(120);
  });

  test('a failed recorder rolls the whole pass back', async () => {
    const [id] = await enqueueN(t.store, 1, { delay: 100 });
    t.clock.advance(100);
    log.failWith(new Error('journal down'));
    await expect(t.store.promoteDue()).rejects.toThrow('journal down');
    log.failWith(null);
    expect(await readJob(t, id!)).toMatchObject({ state: 'delayed', version: '0' });
  });

  describe('a due job is promoted by one pass at any scale', () => {
    test.each([1, 999, 1_000, 1_001])('%d jobs, limit 1,000', async (count) => {
      await enqueueN(t.store, count, { delay: 100 });
      t.clock.advance(100);
      const first = await t.store.promoteDue(1_000);
      expect(first).toEqual({ promoted: Math.min(count, 1_000), more: count > 1_000 });
      const rest = count - first.promoted;
      expect((await t.store.promoteDue(1_000)).promoted).toBe(rest);
    });
  });
});
