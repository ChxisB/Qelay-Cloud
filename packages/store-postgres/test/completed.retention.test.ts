import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const MINUTE = 60_000;
const KEEP = 10 * MINUTE;
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('tick: completed jobs past their retention', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ completedRetentionMs: KEEP, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const tick = (budget: Partial<TickBudget> = {}) => t.store.tick({ ...BUDGET, ...budget });
  const states = async () =>
    (
      await t.fresh.sql<Array<{ id: string; state: string }>>`
        SELECT id, state FROM qcloud_jobs ORDER BY created_at, id`
    ).map((row) => [row.id, row.state]);

  /** Claims and completes `count` jobs of `queue`, one at a time, so they finish `1 ms` apart. */
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

  test('a job is deleted once it finished more than the retention ago, and not before', async () => {
    const [done] = await finished(1);
    t.clock.advance(KEEP - 10);
    await tick();
    expect(await states()).toEqual([[done!, 'completed']]);
    t.clock.advance(20);
    await tick();
    expect(await states()).toEqual([]);
  });

  test('only completed jobs go: waiting, active, delayed and failed ones stay, and so does a completion record', async () => {
    const [done] = await finished(1);
    const lost = await claimOne(t, { attempts: 1 });
    await t.store.fail(lost.lease, { message: 'boom', unrecoverable: true });
    const active = await claimOne(t);
    const [waiting] = await enqueueN(t.store, 1);
    const [delayed] = await enqueueN(t.store, 1, { delay: MINUTE });
    t.clock.advance(KEEP * 3);
    await tick();
    const left = (await states()).map(([id]) => id).sort();
    expect(left).toEqual([active.id, delayed!, lost.id, waiting!].sort());
    expect(left).not.toContain(done!);
    const [{ n }] = await t.fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_completions WHERE job_id = ${done!}`;
    expect(n).toBe(1);
  });

  test('every queue is swept, the oldest finished first, maxItems at a time, and the tick says there is more', async () => {
    const first = await finished(3, 'a');
    const second = await finished(3, 'b');
    t.clock.advance(KEEP * 2);
    const one = await tick({ maxItems: 4 });
    expect(one.moreWork).toBe(true);
    expect((await states()).map(([id]) => id)).toEqual(second.slice(1));
    const two = await tick({ maxItems: 4 });
    expect(two.moreWork).toBe(false);
    expect(await states()).toEqual([]);
    expect(first).toHaveLength(3);
  });

  test('a job a live job depends on is kept, until that job is done with it', async () => {
    const [dependency] = await finished(1);
    const [consumer] = await enqueueN(t.store, 1, {}, 'flow');
    await t.fresh.sql`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      VALUES ('test', ${consumer!}, ${dependency!})`;
    t.clock.advance(KEEP * 2);
    await tick();
    expect((await states()).map(([id]) => id)).toContain(dependency!);
    const [job] = await t.store.claim('flow', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    await tick();
    expect((await states()).map(([id]) => id)).not.toContain(dependency!);
  });

  test('a retention of 0 keeps completed jobs for ever', async () => {
    const keeper = t.another({ completedRetentionMs: 0 });
    const [done] = await finished(1);
    t.clock.advance(KEEP * 1000);
    await keeper.tick(BUDGET);
    expect(await states()).toEqual([[done!, 'completed']]);
  });
});
