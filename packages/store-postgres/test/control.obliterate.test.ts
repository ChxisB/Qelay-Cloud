import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { FlowProtectedError, JobStateError, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { advisoryLockName } from '../src/store/locks';
import { claimOne, metric, recording, resetTables } from './finishHelpers';
import { makeFlow, remainingIds } from './flowFixtures';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

describeDb('control: obliterate a queue', () => {
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

  const rowCount = async (table: string, queue: string): Promise<number> => {
    const [row] = await t.fresh.sql.unsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM ${table} WHERE queue = $1`,
      [queue]
    );
    return row!.count;
  };

  /** A queue with a job in every state, a log line, a group, a completion and metrics. */
  const populate = async (queue: string): Promise<void> => {
    const done = await claimOne(t, {}, queue);
    await t.store.complete(done.lease, 'r');
    const failed = await claimOne(t, {}, queue);
    await t.store.fail(failed.lease, { message: 'x', unrecoverable: true });
    await enqueueN(t.store, 2, {}, queue);
    await enqueueN(t.store, 1, { delay: 60_000 }, queue);
    await enqueueN(t.store, 1, { group: { id: 'g1' } }, queue);
    await t.store.logs.add(done.id, 'line');
    await t.store.pause(queue);
  };

  test('deletes every job of the queue in any state, and what hangs off the queue', async () => {
    await populate('q');
    await populate('keep');
    log.events.length = 0;
    expect(await t.store.control.obliterate('q')).toEqual({ removed: 6, done: true });
    for (const table of [
      'qcloud_jobs',
      'qcloud_completions',
      'qcloud_queue_state',
      'qcloud_group_state',
      'qcloud_metric_totals',
    ]) {
      expect(await rowCount(table, 'q')).toBe(0);
    }
    expect(await t.fresh.sql`SELECT 1 FROM qcloud_job_logs`).toHaveLength(1);
    expect(await metric(t, 'q', 'completed')).toEqual({ total: 0, buckets: [] });
    // The other queue is untouched, state and all.
    expect(await rowCount('qcloud_jobs', 'keep')).toBe(6);
    expect(await t.store.queues.config('keep')).toMatchObject({ paused: true });
    expect((await metric(t, 'keep', 'completed')).total).toBe(1);
    expect(await t.store.queues.config('q')).toMatchObject({ paused: false });
  });

  test('journals one queue event, whatever the job count', async () => {
    await populate('q');
    log.events.length = 0;
    await t.store.control.obliterate('q');
    expect(log.events).toEqual([
      { type: 'obliterated', queue: 'q', jobId: '__queue__:q', state: null },
    ]);
  });

  test('an unknown queue is done at once and journals nothing', async () => {
    expect(await t.store.control.obliterate('nothing-here')).toEqual({ removed: 0, done: true });
    expect(log.events).toEqual([]);
  });

  test('a limit splits the work over calls; the queue state goes with the last one', async () => {
    await enqueueN(t.store, 5);
    const first = await t.store.control.obliterate('q', { limit: 2 });
    expect(first).toEqual({ removed: 2, done: false });
    expect(await rowCount('qcloud_queue_state', 'q')).toBe(1);
    expect(log.events.filter((event) => event.type === 'obliterated')).toEqual([]);
    let calls = 0;
    let report = first;
    while (!report.done && calls++ < 10)
      report = await t.store.control.obliterate('q', { limit: 2 });
    expect(report.done).toBe(true);
    expect(await remainingIds(t)).toEqual([]);
    expect(await rowCount('qcloud_queue_state', 'q')).toBe(0);
    expect(log.events.filter((event) => event.type === 'obliterated')).toHaveLength(1);
  });

  test('active jobs refuse it unless forced; forced, their workers lose their leases', async () => {
    const active = await claimOne(t);
    await enqueueN(t.store, 2);
    await expect(t.store.control.obliterate('q')).rejects.toBeInstanceOf(JobStateError);
    expect(await remainingIds(t)).toHaveLength(3);
    expect(await t.store.control.obliterate('q', { force: true })).toEqual({
      removed: 3,
      done: true,
    });
    expect((await t.store.complete(active.lease, 'late')).ok).toBe(false);
  });

  test('is refused while a live job in another queue waits on one of its jobs; nothing is deleted', async () => {
    const flow = await makeFlow(t, { parentQueue: 'flows', childQueue: 'q' });
    await enqueueN(t.store, 3);
    await expect(t.store.control.obliterate('q')).rejects.toBeInstanceOf(FlowProtectedError);
    expect(await remainingIds(t, 'q')).toHaveLength(4);
    // Once the parent is gone, the queue can go.
    expect(await t.store.control.remove(flow.parent)).toBe('removed');
    expect(await t.store.control.obliterate('q')).toEqual({ removed: 4, done: true });
  });

  test('a flow whose parent and children are all in the queue goes with it', async () => {
    await makeFlow(t, { parentQueue: 'q', childQueue: 'q', children: 2 });
    expect(await t.store.control.obliterate('q')).toEqual({ removed: 3, done: true });
    expect(await t.fresh.sql`SELECT 1 FROM qcloud_dependencies`).toHaveLength(0);
  });

  test('takes the queue lifecycle lock exclusively: it waits for a running enqueue', async () => {
    await enqueueN(t.store, 1);
    const name = advisoryLockName('queue-lifecycle', 'test', 'q');
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const taken = new Promise<void>((resolve) => (locked = resolve));
    const enqueueLike = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${name}, 0))`;
      locked();
      await held;
    });
    await taken;
    let finished = false;
    const obliterating = t.store.control.obliterate('q').then((report) => {
      finished = true;
      return report;
    });
    await Bun.sleep(300);
    expect(finished).toBe(false);
    release();
    await enqueueLike;
    expect(await obliterating).toEqual({ removed: 1, done: true });
  });

  test('refuses an empty queue name and a bad limit', async () => {
    await expect(t.store.control.obliterate('')).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(t.store.control.obliterate('q', { limit: 0 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
