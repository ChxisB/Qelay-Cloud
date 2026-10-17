import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { completeAndRemove, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const KEEP = 3;

describeDb('maintenance: completion records', () => {
  let t: TestStore;
  let store: ReturnType<TestStore['another']>;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
    store = t.another({ maxCompletedJobs: KEEP });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const kept = async (namespace = 'test') =>
    (
      await t.fresh.sql<Array<{ job_id: string }>>`
        SELECT job_id FROM qcloud_completions WHERE namespace = ${namespace}
        ORDER BY completed_at, job_id`
    ).map((row) => row.job_id);

  test('keeps the newest maxCompletedJobs and deletes the rest, oldest first', async () => {
    const ids = await completeAndRemove(t, 8, 'q', store);
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 5, more: false });
    expect(await kept()).toEqual(ids.slice(-KEEP));
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 0, more: false });
  });

  test('a table at or under the limit loses nothing', async () => {
    await completeAndRemove(t, KEEP, 'q', store);
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 0, more: false });
    expect(await kept()).toHaveLength(KEEP);
  });

  test('counts every queue of the namespace together', async () => {
    const a = await completeAndRemove(t, 3, 'a', store);
    const b = await completeAndRemove(t, 3, 'b', store);
    await store.maintenance.pruneCompletions();
    expect(await kept()).toEqual(b);
    expect(a).toHaveLength(3);
  });

  test('a record whose job still exists is kept, however old', async () => {
    const ids = await enqueueN(store, 8);
    for (const id of ids) {
      const [job] = await store.claim('q', 'w', 1);
      expect(job!.id).toBe(id);
      await store.complete(job!.lease, 'ok');
      t.clock.advance(1);
    }
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 0, more: false });
    expect(await kept()).toHaveLength(8);
    // Once cleaning removes the jobs, the records are past the limit and go.
    await store.maintenance.clean('q', { state: 'completed', olderThanMs: 0 });
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 5, more: false });
    expect(await kept()).toEqual(ids.slice(-KEEP));
  });

  test('a record a live job depends on is kept until that job is done with it', async () => {
    const ids = await completeAndRemove(t, 6, 'q', store);
    const [consumer] = await enqueueN(store, 1, {}, 'flow');
    await t.fresh.sql`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      VALUES ('test', ${consumer!}, ${ids[0]!})`;
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 2, more: false });
    expect(await kept()).toEqual([ids[0]!, ...ids.slice(-KEEP)]);

    const [job] = await store.claim('flow', 'w', 1);
    await store.complete(job!.lease, 'ok');
    // The consumer's own record is now the newest, which pushes ids[3] past the limit as well.
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 2, more: false });
    expect(await kept()).toEqual([ids[4]!, ids[5]!, consumer!]);
  });

  test('a pass deletes at most its limit and says there is more', async () => {
    const ids = await completeAndRemove(t, 10, 'q', store);
    expect(await store.maintenance.pruneCompletions(3)).toEqual({ removed: 3, more: true });
    expect(await store.maintenance.pruneCompletions(3)).toEqual({ removed: 3, more: true });
    expect(await store.maintenance.pruneCompletions(3)).toEqual({ removed: 1, more: false });
    expect(await kept()).toEqual(ids.slice(-KEEP));
  });

  test('exactly the limit is not more', async () => {
    await completeAndRemove(t, KEEP + 2, 'q', store);
    expect(await store.maintenance.pruneCompletions(2)).toEqual({ removed: 2, more: false });
  });

  test('concurrent sweeps never delete more than the excess', async () => {
    const ids = await completeAndRemove(t, 30, 'q', store);
    const sweeps = [
      store,
      t.another({ maxCompletedJobs: KEEP }),
      t.another({ maxCompletedJobs: KEEP }),
    ];
    const reports = await Promise.all(sweeps.map((each) => each.maintenance.pruneCompletions(7)));
    const removed = reports.reduce((sum, report) => sum + report.removed, 0);
    expect(removed).toBeLessThanOrEqual(30 - KEEP);
    expect(await kept()).toEqual(expect.arrayContaining(ids.slice(-KEEP)));
    while ((await store.maintenance.pruneCompletions(7)).more) {
      // Drains what the first round left.
    }
    expect(await kept()).toEqual(ids.slice(-KEEP));
  });

  test('a record an admission holds FOR SHARE is skipped, not waited for', async () => {
    const ids = await completeAndRemove(t, 6, 'q', store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const reader = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT job_id FROM qcloud_completions WHERE job_id = ${ids[1]!} FOR SHARE`;
      locked();
      await held;
    });
    await acquired;
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 2, more: false });
    expect(await kept()).toEqual([ids[1]!, ...ids.slice(-KEEP)]);
    release();
    await reader;
    expect(await store.maintenance.pruneCompletions()).toEqual({ removed: 1, more: false });
    expect(await kept()).toEqual(ids.slice(-KEEP));
  });

  test('leaves other namespaces alone, and counts only its own', async () => {
    const other = t.another({ namespace: 'other', maxCompletedJobs: KEEP });
    const mine = await completeAndRemove(t, 5, 'q', store);
    const theirs = await completeAndRemove(t, 2, 'q', other);
    await store.maintenance.pruneCompletions();
    expect(await kept()).toEqual(mine.slice(-KEEP));
    expect(await kept('other')).toEqual(theirs);
  });

  test.each([0, -3, 2.9])('a limit of %p is read as at least one', async (limit) => {
    await completeAndRemove(t, KEEP + 4, 'q', store);
    const report = await store.maintenance.pruneCompletions(limit);
    expect(report.removed).toBe(Math.max(1, Math.floor(limit)));
  });
});
