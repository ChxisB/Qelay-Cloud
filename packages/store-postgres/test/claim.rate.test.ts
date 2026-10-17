import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind, START } from './storeHelpers';

interface State {
  rate_limit: number | null;
  rate_duration_ms: string | null;
  rate_window_started_at: string | null;
  rate_expires_at: string | null;
  rate_count: number;
}

describeDb('claim: rate limit', () => {
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

  const state = async () =>
    (
      await t.fresh.sql<State[]>`
      SELECT rate_limit, rate_duration_ms, rate_window_started_at, rate_expires_at, rate_count
      FROM qcloud_queue_state WHERE queue = 'q'`
    )[0]!;

  test('at most max jobs per window, however the claims are cut up', async () => {
    await enqueueN(t.store, 20);
    await t.store.setRateLimit('q', { max: 5, durationMs: 1_000 });
    expect(await t.store.claim('q', 'w', 3)).toHaveLength(3);
    expect(await t.store.claim('q', 'w', 3)).toHaveLength(2);
    expect(await t.store.claim('q', 'w', 3)).toEqual([]);
    expect((await state()).rate_count).toBe(5);
  });

  test('a window that has run out restarts at the first claim after it, not on a grid', async () => {
    await enqueueN(t.store, 20);
    await t.store.setRateLimit('q', { max: 2, durationMs: 1_000 });
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(2);
    t.clock.advance(999);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    t.clock.advance(1);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(2);
    expect((await state()).rate_window_started_at).toBe(String(START + 1_000));
    t.clock.advance(1_500);
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(2);
    expect((await state()).rate_window_started_at).toBe(String(START + 2_500));
  });

  test('a claim that finds nothing still moves an expired window on', async () => {
    await t.store.setRateLimit('q', { max: 2, durationMs: 1_000 });
    t.clock.advance(5_000);
    await t.store.claim('q', 'w', 1);
    expect(await state()).toMatchObject({
      rate_count: 0,
      rate_window_started_at: String(START + 5_000),
    });
  });

  test('a limit that names no duration uses one second', async () => {
    await t.store.setRateLimit('q', { max: 4 });
    expect(await state()).toMatchObject({ rate_limit: 4, rate_duration_ms: '1000' });
  });

  test('setting a limit starts a fresh window, even when it is the same limit', async () => {
    await enqueueN(t.store, 10);
    await t.store.setRateLimit('q', { max: 2, durationMs: 60_000 });
    await t.store.claim('q', 'w', 2);
    expect(await t.store.claim('q', 'w', 2)).toEqual([]);
    t.clock.advance(10);
    await t.store.setRateLimit('q', { max: 2, durationMs: 60_000 });
    expect(await state()).toMatchObject({
      rate_count: 0,
      rate_window_started_at: String(START + 10),
    });
    expect(await t.store.claim('q', 'w', 2)).toHaveLength(2);
  });

  test('null removes the limit and its window', async () => {
    await enqueueN(t.store, 10);
    await t.store.setRateLimit('q', { max: 1, durationMs: 60_000, ttlMs: 90_000 });
    await t.store.claim('q', 'w', 5);
    await t.store.setRateLimit('q', null);
    expect(await state()).toEqual({
      rate_limit: null,
      rate_duration_ms: null,
      rate_window_started_at: null,
      rate_expires_at: null,
      rate_count: 0,
    });
    expect(await t.store.claim('q', 'w', 5)).toHaveLength(5);
  });

  test('the limit is per queue', async () => {
    await enqueueN(t.store, 5, {}, 'a');
    await enqueueN(t.store, 5, {}, 'b');
    await t.store.setRateLimit('a', { max: 1, durationMs: 60_000 });
    expect(await t.store.claim('a', 'w', 5)).toHaveLength(1);
    expect(await t.store.claim('b', 'w', 5)).toHaveLength(5);
  });

  test('a claim does not use up the window for jobs it did not take', async () => {
    await enqueueN(t.store, 1);
    await t.store.setRateLimit('q', { max: 5, durationMs: 60_000 });
    await t.store.claim('q', 'w', 5);
    expect((await state()).rate_count).toBe(1);
  });

  test('a job given back does not return its slot in the window', async () => {
    await enqueueN(t.store, 3);
    await t.store.setRateLimit('q', { max: 1, durationMs: 60_000 });
    const [job] = await t.store.claim('q', 'w', 1);
    await t.store.release(job!.lease);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
  });

  describe('ttlMs', () => {
    test('the limit lifts itself once the ttl has passed', async () => {
      await enqueueN(t.store, 10);
      await t.store.setRateLimit('q', { max: 1, durationMs: 60_000, ttlMs: 5_000 });
      expect((await state()).rate_expires_at).toBe(String(START + 5_000));
      expect(await t.store.claim('q', 'w', 5)).toHaveLength(1);
      t.clock.advance(4_999);
      expect(await t.store.claim('q', 'w', 5)).toEqual([]);
      t.clock.advance(1);
      expect(await t.store.claim('q', 'w', 5)).toHaveLength(5);
      expect(await state()).toMatchObject({
        rate_limit: null,
        rate_expires_at: null,
        rate_count: 0,
      });
    });
  });

  describe('validation', () => {
    test.each([
      ['max of 0', { max: 0 }],
      ['a negative max', { max: -1 }],
      ['a fractional max', { max: 1.5 }],
      ['a NaN max', { max: Number.NaN }],
      ['a duration of 0', { max: 1, durationMs: 0 }],
      ['an infinite duration', { max: 1, durationMs: Infinity }],
      ['a negative ttl', { max: 1, ttlMs: -5 }],
    ])('%s is refused and changes nothing', async (_label, limit) => {
      await t.store.setRateLimit('q', { max: 7, durationMs: 1_000 });
      await expect(t.store.setRateLimit('q', limit)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPTION',
      });
      expect(await state()).toMatchObject({ rate_limit: 7 });
    });

    test('a fractional duration is rounded up', async () => {
      await t.store.setRateLimit('q', { max: 1, durationMs: 10.2 });
      expect((await state()).rate_duration_ms).toBe('11');
    });

    test('the queue name is validated', async () => {
      await expect(t.store.setRateLimit('', { max: 1 })).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPTION',
      });
    });
  });

  describe('bells', () => {
    test('setting a limit clears the due bells, as a resume does', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      await t.store.setRateLimit('q', { max: 1 });
      const rows = await t.fresh.sql`SELECT rung_at FROM qcloud_jobs WHERE id = ${id!}`;
      expect(rows[0]!.rung_at).toBeNull();
    });

    test('a window that rolls over does not clear any bell: the tick owns that (task 15)', async () => {
      const [, , third] = await enqueueN(t.store, 3);
      await t.store.setRateLimit('q', { max: 1, durationMs: 1_000 });
      await t.store.claim('q', 'w', 1);
      await t.store.markRung([{ jobId: third!, deliverAfterMs: 0 }]);
      t.clock.advance(2_000);
      expect(await t.store.claim('q', 'w', 1)).toHaveLength(1);
      const rows = await t.fresh.sql`SELECT rung_at FROM qcloud_jobs WHERE id = ${third!}`;
      expect(rows[0]!.rung_at).toBe(String(START));
    });
  });
});
