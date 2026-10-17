import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_CLEAN_LIMIT } from '../src/store/clean';
import type { JournalEvent } from '../src/store/journal';
import { claimOne, completeAndRemove, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const MINUTE = 60_000;

describeDb('maintenance: clean finished jobs', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const clean = (state: 'completed' | 'failed', olderThanMs = 0, limit?: number, queue = 'q') =>
    t.store.maintenance.clean(queue, { state, olderThanMs, ...(limit && { limit }) });

  /** Claims and completes `count` jobs of `queue`, a millisecond apart, oldest created first. */
  async function finished(count: number, queue = 'q'): Promise<string[]> {
    const ids = await enqueueN(t.store, count, {}, queue);
    for (const id of ids) {
      const [job] = await t.store.claim(queue, 'w', 1);
      expect(job!.id).toBe(id);
      await t.store.complete(job!.lease, 'ok');
      t.clock.advance(1);
    }
    return ids;
  }

  async function failed(queue = 'q'): Promise<string> {
    const job = await claimOne(t, { attempts: 1 }, queue);
    await t.store.fail(job.lease, { message: 'boom', unrecoverable: true });
    return job.id;
  }

  const rows = async () =>
    (
      await t.fresh.sql<Array<{ id: string; state: string }>>`
        SELECT id, state FROM qcloud_jobs ORDER BY created_at, id`
    ).map((row) => [row.id, row.state]);

  test('removes completed jobs and leaves failed ones, and the other way round', async () => {
    const [done] = await finished(1);
    const lost = await failed();
    expect(await clean('completed')).toEqual({ removed: [done!], more: false });
    expect(await rows()).toEqual([[lost, 'failed']]);
    expect(await clean('failed')).toEqual({ removed: [lost], more: false });
    expect(await rows()).toEqual([]);
  });

  test('leaves jobs that have not finished', async () => {
    await finished(1);
    const active = await claimOne(t);
    const [waiting] = await enqueueN(t.store, 1);
    const [delayed] = await enqueueN(t.store, 1, { delay: MINUTE });
    await clean('completed');
    expect((await rows()).map(([id]) => id).sort()).toEqual([active.id, delayed!, waiting!].sort());
  });

  test('only a job that finished at least olderThanMs ago is removed', async () => {
    const [job] = await finished(1);
    t.clock.advance(MINUTE - 1 - 1);
    // The job finished MINUTE - 1 ms ago: one millisecond short.
    expect(await clean('completed', MINUTE)).toEqual({ removed: [], more: false });
    t.clock.advance(1);
    expect(await clean('completed', MINUTE)).toEqual({ removed: [job!], more: false });
  });

  test('takes the oldest created first, at most the limit, and says there is more', async () => {
    const ids = await finished(5);
    expect(await clean('completed', 0, 2)).toEqual({ removed: ids.slice(0, 2), more: true });
    expect(await clean('completed', 0, 2)).toEqual({ removed: ids.slice(2, 4), more: true });
    expect(await clean('completed', 0, 2)).toEqual({ removed: ids.slice(4), more: false });
    expect(await clean('completed', 0, 2)).toEqual({ removed: [], more: false });
  });

  test('exactly the limit is not more', async () => {
    const ids = await finished(3);
    expect(await clean('completed', 0, 3)).toEqual({ removed: ids, more: false });
  });

  test('leaves other queues and other namespaces alone', async () => {
    await finished(2, 'q');
    const [other] = await finished(1, 'other');
    const sibling = t.another({ namespace: 'sibling' });
    await enqueueN(sibling, 1, {}, 'q');
    const [claimed] = await sibling.claim('q', 'w', 1);
    await sibling.complete(claimed!.lease, 'ok');
    expect((await clean('completed')).removed).toHaveLength(2);
    expect((await rows()).map(([id]) => id)).toContain(other!);
    const [{ n }] = await t.fresh.sql<
      [{ n: number }]
    >`SELECT count(*)::int AS n FROM qcloud_jobs WHERE namespace = 'sibling'`;
    expect(n).toBe(1);
  });

  test('journals each removal, with the state it was removed from and why', async () => {
    const [job] = await finished(1);
    const lost = await failed();
    const before = await t.store.events.baseline();
    await clean('completed');
    await clean('failed');
    const page = await t.store.events.read(before);
    expect(page.gap).toBe(false);
    expect(
      (page.events as readonly JournalEvent[]).map((event) => [
        event.type,
        event.jobId,
        event.state,
        event.error,
      ])
    ).toEqual([
      ['removed', job!, 'completed', 'cleaned'],
      ['removed', lost, 'failed', 'cleaned'],
    ]);
  });

  test('deletes the job’s log lines with it, and keeps its completion record', async () => {
    const job = await claimOne(t);
    await t.store.logs.add(job.id, 'working');
    await t.store.complete(job.lease, 'ok');
    expect(await t.store.logs.list(job.id)).toHaveLength(1);
    await clean('completed');
    expect(await t.store.logs.list(job.id)).toEqual([]);
    const [{ n }] = await t.fresh.sql<
      [{ n: number }]
    >`SELECT count(*)::int AS n FROM qcloud_completions WHERE job_id = ${job.id}`;
    expect(n).toBe(1);
  });

  test('a job that a live job depends on is kept, until that job is done with it', async () => {
    const [dependency] = await finished(1);
    const [consumer] = await enqueueN(t.store, 1, {}, 'flow');
    await t.fresh.sql`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      VALUES ('test', ${consumer!}, ${dependency!})`;
    expect(await clean('completed')).toEqual({ removed: [], more: false });
    expect((await rows()).map(([id]) => id)).toContain(dependency!);

    const [job] = await t.store.claim('flow', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    expect(await clean('completed')).toMatchObject({ removed: [dependency!] });
  });

  test('a job that a finished job depended on is not kept', async () => {
    const [dependency, consumer] = await finished(2);
    await t.fresh.sql`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      VALUES ('test', ${consumer!}, ${dependency!})`;
    expect((await clean('completed')).removed).toEqual([dependency, consumer]);
  });

  test('a job whose row another transaction holds is skipped, not waited for', async () => {
    const [first, second, third] = await finished(3);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT id FROM qcloud_jobs WHERE id = ${second!} FOR UPDATE`;
      locked();
      await held;
    });
    await acquired;
    expect(await clean('completed')).toEqual({ removed: [first, third], more: false });
    release();
    await holder;
    expect(await clean('completed')).toEqual({ removed: [second], more: false });
  });

  test('two cleans at once remove each job once', async () => {
    const ids = await finished(20);
    const other = t.another();
    const reports = await Promise.all([
      clean('completed'),
      other.maintenance.clean('q', { state: 'completed', olderThanMs: 0 }),
    ]);
    const removed = reports.flatMap((report) => report.removed);
    expect(new Set(removed).size).toBe(removed.length);
    expect(new Set(removed)).toEqual(new Set(ids));
  });

  test('the removed jobs of a removeOnComplete queue are not found: there is nothing to clean', async () => {
    await completeAndRemove(t, 2);
    expect(await clean('completed')).toEqual({ removed: [], more: false });
  });

  test.each<[string, () => Promise<unknown>, string]>([
    [
      'a state that is not finished',
      () => t.store.maintenance.clean('q', { state: 'waiting' as 'failed', olderThanMs: 0 }),
      'state',
    ],
    ['a negative grace', () => clean('completed', -1), 'olderThanMs'],
    ['a fractional grace', () => clean('completed', 1.5), 'olderThanMs'],
    [
      'a zero limit',
      () => t.store.maintenance.clean('q', { state: 'completed', olderThanMs: 0, limit: 0 }),
      'limit',
    ],
    [
      'a limit over the cap',
      () =>
        t.store.maintenance.clean('q', {
          state: 'completed',
          olderThanMs: 0,
          limit: MAX_CLEAN_LIMIT + 1,
        }),
      'limit',
    ],
  ])('refuses %s', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
  });
});
