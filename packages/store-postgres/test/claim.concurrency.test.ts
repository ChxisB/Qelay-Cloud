import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

describeDb('claim: concurrency limit', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state`;
    rewind(t);
  });

  test('never more active jobs than the limit', async () => {
    await enqueueN(t.store, 10);
    await t.store.setConcurrencyLimit('q', 3);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(3);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    expect((await t.store.counts('q')).active).toBe(3);
  });

  test('a job given back makes room for exactly one more', async () => {
    await enqueueN(t.store, 10);
    await t.store.setConcurrencyLimit('q', 2);
    const [first] = await t.store.claim('q', 'w', 2);
    await t.store.release(first!.lease);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(1);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
  });

  test('a lease that expired is not counted: recovery owns the job, the slot is free', async () => {
    await enqueueN(t.store, 5);
    await t.store.setConcurrencyLimit('q', 2);
    await t.store.claim('q', 'w', 2);
    t.clock.advance(30_000);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(2);
  });

  test('a renewed lease keeps its slot', async () => {
    await enqueueN(t.store, 5);
    await t.store.setConcurrencyLimit('q', 1);
    const [job] = await t.store.claim('q', 'w', 1);
    t.clock.advance(29_000);
    await t.store.heartbeat(job!.lease);
    t.clock.advance(29_000);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
  });

  test('lowering the limit does not revoke a lease; raising it opens room', async () => {
    await enqueueN(t.store, 10);
    await t.store.setConcurrencyLimit('q', 4);
    await t.store.claim('q', 'w', 4);
    await t.store.setConcurrencyLimit('q', 2);
    expect((await t.store.counts('q')).active).toBe(4);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    await t.store.setConcurrencyLimit('q', 6);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(2);
  });

  test('null removes the limit', async () => {
    await enqueueN(t.store, 6);
    await t.store.setConcurrencyLimit('q', 1);
    await t.store.setConcurrencyLimit('q', null);
    expect(await t.store.claim('q', 'w', 6)).toHaveLength(6);
  });

  test('it counts the jobs of the queue only', async () => {
    await enqueueN(t.store, 3, {}, 'a');
    await enqueueN(t.store, 3, {}, 'b');
    await t.store.setConcurrencyLimit('a', 1);
    expect(await t.store.claim('a', 'w', 5)).toHaveLength(1);
    expect(await t.store.claim('b', 'w', 5)).toHaveLength(3);
  });

  test('with a rate limit too, the tighter of the two applies', async () => {
    await enqueueN(t.store, 10);
    await t.store.setConcurrencyLimit('q', 4);
    await t.store.setRateLimit('q', { max: 2, durationMs: 1_000 });
    expect(await t.store.claim('q', 'w', 10)).toHaveLength(2);
    t.clock.advance(1_000);
    expect(await t.store.claim('q', 'w', 10)).toHaveLength(2);
    t.clock.advance(1_000);
    expect(await t.store.claim('q', 'w', 10)).toEqual([]);
  });

  test('a limit and a paused queue: the pause wins', async () => {
    await enqueueN(t.store, 2);
    await t.store.setConcurrencyLimit('q', 5);
    await t.store.pause('q');
    expect(await t.store.claim('q', 'w', 2)).toEqual([]);
  });

  test('setting a limit clears the due bells', async () => {
    const [id] = await enqueueN(t.store, 1);
    await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
    await t.store.setConcurrencyLimit('q', 1);
    const rows = await t.fresh.sql`SELECT rung_at FROM qcloud_jobs WHERE id = ${id!}`;
    expect(rows[0]!.rung_at).toBeNull();
  });

  test.each([
    ['0', 0],
    ['a negative number', -1],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
  ])('%s is refused and changes nothing', async (_label, limit) => {
    await t.store.setConcurrencyLimit('q', 3);
    await expect(t.store.setConcurrencyLimit('q', limit)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION',
    });
    const rows = await t.fresh
      .sql`SELECT concurrency_limit FROM qcloud_queue_state WHERE queue = 'q'`;
    expect(rows[0]!.concurrency_limit).toBe(3);
  });

  test('the queue name is validated', async () => {
    await expect(t.store.setConcurrencyLimit('', 1)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION',
    });
  });
});
