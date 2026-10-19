import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

/**
 * Each commit that writes events takes the namespace's commit lock once, and the sequence advances
 * once under it, so the sequence counts lock passes. Batching is the first step against that lock
 * (limits.md, "Every commit that writes events serializes per namespace"): a batch is one pass.
 */
describeDb('event journal: one commit-lock pass per transaction, not per job', () => {
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

  const passes = async (): Promise<number> => {
    const [row] = await t.fresh.sql<Array<{ n: string }>>`
      SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM qcloud_event_commit_seq`;
    return Number(row!.n);
  };
  const jobs = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ queue: 'q', data: n }));

  test('50 jobs added one by one take 50 passes, added in one call take 1', async () => {
    let before = await passes();
    for (const job of jobs(50)) await t.store.enqueue([job]);
    expect((await passes()) - before).toBe(50);
    before = await passes();
    await t.store.enqueue(jobs(50));
    expect((await passes()) - before).toBe(1);
  });

  test('50 jobs completed one by one take 50 passes, with completeMany 1', async () => {
    await t.store.enqueue(jobs(100));
    const claimed = await t.store.claim('q', 'w', 100);
    expect(claimed).toHaveLength(100);
    let before = await passes();
    for (const job of claimed.slice(0, 50)) await t.store.complete(job.lease, null);
    expect((await passes()) - before).toBe(50);
    before = await passes();
    await t.store.completeMany(
      claimed.slice(50).map((job) => ({ lease: job.lease, result: null }))
    );
    expect((await passes()) - before).toBe(1);
  });
});
