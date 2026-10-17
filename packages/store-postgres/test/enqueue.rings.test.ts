import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

describeDb('enqueue: rings', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs`;
    rewind(t);
  });

  /** The job's `rung_at`: null when unset, undefined when there is no such job. */
  const rungAt = async (id: string, namespace = 'test') => {
    const rows = await t.fresh.sql<Array<{ rung_at: string | null }>>`
      SELECT rung_at FROM qcloud_jobs WHERE namespace = ${namespace} AND id = ${id}`;
    return rows.length === 0 ? undefined : rows[0]!.rung_at;
  };

  describe('the ring enqueue returns', () => {
    test('a claimable job is rung now, and nothing is marked until the caller reports back', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      expect(job!.ring).toEqual({
        bell: { namespace: 'test', queue: 'q', jobId: job!.id },
        dueInMs: 0,
      });
      expect(await rungAt(job!.id)).toBeNull();
    });

    test('a prioritized job is claimable too', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { priority: 3 } }]);
      expect(job!.ring).toMatchObject({ dueInMs: 0 });
    });

    test('a delayed job gets no ring by default: the tick rings it near its time', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { delay: 1 } }]);
      expect(job).toMatchObject({ state: 'delayed', ring: null });
    });

    test('a duplicate gets no ring', async () => {
      await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'a' } }]);
      const [dup] = await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'a' } }]);
      expect(dup!.ring).toBeNull();
    });

    test('one ring per created job, in input order', async () => {
      const results = await t.store.enqueue([
        { queue: 'a', data: 1 },
        { queue: 'b', data: 2, options: { delay: 60_000 } },
        { queue: 'c', data: 3 },
      ]);
      expect(results.map((r) => r.ring?.bell.queue ?? null)).toEqual(['a', null, 'c']);
    });
  });

  describe('ringWindowMs: how far ahead the transport can hold a bell', () => {
    test.each([
      [4_999, true, 4_999],
      [5_000, true, 5_000],
      [5_001, false, 0],
    ])('a job delayed %d ms with a 5,000 ms window: ring is %p', async (delay, rung, dueInMs) => {
      const windowed = t.another({ ringWindowMs: 5_000 });
      const [job] = await windowed.enqueue([{ queue: 'q', data: 1, options: { delay } }]);
      if (rung) expect(job!.ring).toMatchObject({ dueInMs });
      else expect(job!.ring).toBeNull();
    });

    test('a claimable job is still rung with dueInMs 0 under a window', async () => {
      const windowed = t.another({ ringWindowMs: 5_000 });
      const [job] = await windowed.enqueue([{ queue: 'q', data: 1 }]);
      expect(job!.ring!.dueInMs).toBe(0);
    });

    test('dueInMs is measured on the clock at the call', async () => {
      const windowed = t.another({ ringWindowMs: 10_000 });
      t.clock.advance(250);
      const [job] = await windowed.enqueue([{ queue: 'q', data: 1, options: { delay: 4_000 } }]);
      expect(job!.ring!.dueInMs).toBe(4_000);
      t.clock.advance(-250);
    });
  });

  describe('markRung', () => {
    test('sets rung_at to the database time plus the delay the broker took the bell for', async () => {
      const [now, later] = await t.store.enqueue([
        { queue: 'q', data: 1 },
        { queue: 'q', data: 2 },
      ]);
      await t.store.markRung([
        { jobId: now!.id, deliverAfterMs: 0 },
        { jobId: later!.id, deliverAfterMs: 2_500 },
      ]);
      expect(await rungAt(now!.id)).toBe(String(START));
      expect(await rungAt(later!.id)).toBe(String(START + 2_500));
    });

    test('is safe to call twice: the same entries on the same clock change nothing', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      const entry = [{ jobId: job!.id, deliverAfterMs: 1_000 }];
      await t.store.markRung(entry);
      const once = await t.store.getJob(job!.id);
      await t.store.markRung(entry);
      expect(await rungAt(job!.id)).toBe(String(START + 1_000));
      expect(await t.store.getJob(job!.id)).toEqual(once);
    });

    test('marks only the bells it is given', async () => {
      const results = await t.store.enqueue(
        Array.from({ length: 5 }, (_, n) => ({ queue: 'q', data: n }))
      );
      await t.store.markRung([
        { jobId: results[1]!.id, deliverAfterMs: 0 },
        { jobId: results[3]!.id, deliverAfterMs: 0 },
      ]);
      expect(await Promise.all(results.map((r) => rungAt(r.id)))).toEqual([
        null,
        String(START),
        null,
        String(START),
        null,
      ]);
    });

    test.each(['active', 'completed', 'failed', 'waiting-children'] as const)(
      'does not mark a job that is %s',
      async (state) => {
        const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
        await t.fresh.sql`UPDATE qcloud_jobs SET state = ${state} WHERE id = ${job!.id}`;
        await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 0 }]);
        expect(await rungAt(job!.id)).toBeNull();
      }
    );

    test('ignores an id that does not exist, and the rest of the call still lands', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      await t.store.markRung([
        { jobId: 'ghost', deliverAfterMs: 0 },
        { jobId: job!.id, deliverAfterMs: 0 },
      ]);
      expect(await rungAt(job!.id)).toBe(String(START));
      expect(await rungAt('ghost')).toBeUndefined();
    });

    test('an empty list is a no-op', async () => {
      await t.store.markRung([]);
    });

    test('two entries for one job record the earlier delivery', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      await t.store.markRung([
        { jobId: job!.id, deliverAfterMs: 5_000 },
        { jobId: job!.id, deliverAfterMs: 1_000 },
      ]);
      expect(await rungAt(job!.id)).toBe(String(START + 1_000));
    });

    test('a negative or non-numeric delay counts as 0', async () => {
      const [a, b] = await t.store.enqueue([
        { queue: 'q', data: 1 },
        { queue: 'q', data: 2 },
      ]);
      await t.store.markRung([
        { jobId: a!.id, deliverAfterMs: -50 },
        { jobId: b!.id, deliverAfterMs: Number.NaN },
      ]);
      expect(await rungAt(a!.id)).toBe(String(START));
      expect(await rungAt(b!.id)).toBe(String(START));
    });

    test('a delayed job inside the window is marked for its pre-ring', async () => {
      const windowed = t.another({ ringWindowMs: 10_000 });
      const [job] = await windowed.enqueue([{ queue: 'q', data: 1, options: { delay: 4_000 } }]);
      await windowed.markRung([{ jobId: job!.id, deliverAfterMs: job!.ring!.dueInMs }]);
      expect(await rungAt(job!.id)).toBe(String(START + 4_000));
    });

    test("only touches the store's own namespace", async () => {
      const other = t.another({ namespace: 'other' });
      const options = { jobId: 'same' };
      await t.store.enqueue([{ queue: 'q', data: 1, options }]);
      await other.enqueue([{ queue: 'q', data: 1, options }]);
      await t.store.markRung([{ jobId: 'same', deliverAfterMs: 0 }]);
      expect(await rungAt('same', 'test')).toBe(String(START));
      expect(await rungAt('same', 'other')).toBeNull();
    });

    test('a slow ring: enqueue leaves rung_at null, and the late report counts from when it is made', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      t.clock.advance(7_000);
      expect(await rungAt(job!.id)).toBeNull();
      await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 500 }]);
      expect(await rungAt(job!.id)).toBe(String(START + 7_000 + 500));
      t.clock.advance(-7_000);
    });

    test('a later report moves an earlier one: the last bell the broker took is the one on record', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 0 }]);
      t.clock.advance(3_000);
      await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 0 }]);
      expect(await rungAt(job!.id)).toBe(String(START + 3_000));
      t.clock.advance(-3_000);
    });

    test('a fresh job written over a finished generation starts unrung', async () => {
      const [old] = await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'again' } }]);
      await t.store.markRung([{ jobId: old!.id, deliverAfterMs: 0 }]);
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'completed' WHERE id = 'again'`;
      await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'again' } }]);
      expect(await rungAt('again')).toBeNull();
    });
  });
});
