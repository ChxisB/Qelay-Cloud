import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind, START } from './storeHelpers';

describeDb('claim: pause and resume', () => {
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

  const rungAt = async (id: string) =>
    (
      await t.fresh.sql<
        { rung_at: string | null }[]
      >`SELECT rung_at FROM qcloud_jobs WHERE id = ${id}`
    )[0]!.rung_at;

  test('a paused queue gives nothing, and the jobs stay where they are', async () => {
    await enqueueN(t.store, 3);
    await t.store.pause('q');
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    expect((await t.store.counts('q')).waiting).toBe(3);
  });

  test('resume makes the jobs claimable again', async () => {
    await enqueueN(t.store, 3);
    await t.store.pause('q');
    await t.store.resume('q');
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(3);
  });

  test('only the paused queue is held back', async () => {
    await enqueueN(t.store, 1, {}, 'a');
    await enqueueN(t.store, 1, {}, 'b');
    await t.store.pause('a');
    expect(await t.store.claim('a', 'w', 1)).toEqual([]);
    expect(await t.store.claim('b', 'w', 1)).toHaveLength(1);
  });

  test('pause and resume are idempotent and work on a queue nobody used', async () => {
    await t.store.pause('fresh');
    await t.store.pause('fresh');
    expect(await t.store.claim('fresh', 'w', 1)).toEqual([]);
    await t.store.resume('fresh');
    await t.store.resume('fresh');
    await t.store.resume('never-paused');
    const rows = await t.fresh.sql`SELECT queue, paused FROM qcloud_queue_state ORDER BY queue`;
    expect([...rows]).toEqual([
      { queue: 'fresh', paused: false },
      { queue: 'never-paused', paused: false },
    ]);
  });

  test('a job enqueued while the queue is paused waits for the resume', async () => {
    await t.store.pause('q');
    await enqueueN(t.store, 1);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    await t.store.resume('q');
    expect(await t.store.claim('q', 'w', 1)).toHaveLength(1);
  });

  test('a pause does not touch jobs already leased: they renew and are given back', async () => {
    await enqueueN(t.store, 2);
    const [job, other] = await t.store.claim('q', 'w', 2);
    await t.store.pause('q');
    expect(await t.store.heartbeat(job!.lease)).toBe(true);
    expect((await t.store.release(other!.lease)).ok).toBe(true);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    expect((await t.store.counts('q')).active).toBe(1);
  });

  test('another store on the same schema sees the pause at once', async () => {
    await enqueueN(t.store, 1);
    await t.store.pause('q');
    expect(await t.another().claim('q', 'x', 1)).toEqual([]);
  });

  test('queue names are validated', async () => {
    await expect(t.store.pause('')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
    await expect(t.store.resume('a\0b')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
  });

  describe('bells', () => {
    test('a pause leaves rung_at alone', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      await t.store.pause('q');
      expect(await rungAt(id!)).toBe(String(START));
    });

    test('a resume clears the bells that were due, so the tick rings them again', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      await t.store.pause('q');
      t.clock.advance(1_000);
      await t.store.resume('q');
      expect(await rungAt(id!)).toBeNull();
    });

    test('a resume keeps a bell that is not due yet: it is still in flight', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 60_000 });
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 60_000 }]);
      await t.store.pause('q');
      await t.store.resume('q');
      expect(await rungAt(id!)).toBe(String(START + 60_000));
    });

    test('a resume leaves the bells of other queues alone', async () => {
      const [a] = await enqueueN(t.store, 1, {}, 'a');
      const [b] = await enqueueN(t.store, 1, {}, 'b');
      await t.store.markRung([
        { jobId: a!, deliverAfterMs: 0 },
        { jobId: b!, deliverAfterMs: 0 },
      ]);
      await t.store.resume('a');
      expect(await rungAt(a!)).toBeNull();
      expect(await rungAt(b!)).toBe(String(START));
    });

    test('the bell of a paused claim is spent, which is why the resume clears it', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      await t.store.pause('q');
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
      expect(await rungAt(id!)).toBe(String(START));
    });
  });
});
