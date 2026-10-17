import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { createMsgpackCodec } from '../src/codec';
import { BatchTooLargeError } from '../src/errors';
import type { Envelope } from '../src/store/prepare';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

interface Row {
  id: string;
  state: string;
  priority: number;
  lifo: boolean;
  run_at: string;
  created_at: string;
  rung_at: string | null;
  max_attempts: number;
  attempts: number;
  timeout: string | null;
  ttl: string | null;
  version: string;
  custom_id: string | null;
  group_id: string | null;
  group_order: string | null;
  unique_key: string | null;
  payload: Uint8Array;
}

describeDb('enqueue: admission', () => {
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

  const rows = () => t.fresh.sql<Row[]>`SELECT * FROM qcloud_jobs ORDER BY id`;
  const row = async (id: string) => (await rows()).find((r) => r.id === id)!;

  describe('the state a job starts in', () => {
    test.each([
      ['no options', {}, 'waiting', 0],
      ['a priority', { priority: 5 }, 'prioritized', 5],
      ['priority 0', { priority: 0 }, 'waiting', 0],
      ['a delay', { delay: 1_000 }, 'delayed', 0],
      ['a delay and a priority: the delay decides', { delay: 1_000, priority: 9 }, 'delayed', 9],
      ['delay 0', { delay: 0 }, 'waiting', 0],
      ['a negative delay reads as 0', { delay: -5_000 }, 'waiting', 0],
      ['a fractional delay rounds down', { delay: 0.9 }, 'waiting', 0],
      [
        'a group priority sets the order column',
        { group: { id: 'g', priority: 3 } },
        'prioritized',
        3,
      ],
    ] as const)('%s', async (_label, options, state, priority) => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options }]);
      expect(job!.state).toBe(state);
      const stored = await row(job!.id);
      expect(stored.state).toBe(state);
      expect(stored.priority).toBe(priority);
    });

    test('a priority above the INTEGER range is clamped to the column', async () => {
      const [job] = await t.store.enqueue([
        { queue: 'q', data: 1, options: { priority: 2 ** 40 } },
      ]);
      expect((await row(job!.id)).priority).toBe(2_147_483_647);
    });
  });

  test('the row carries the clock, the options and nothing else', async () => {
    const [job] = await t.store.enqueue([
      {
        queue: 'q',
        name: 'send',
        data: { n: 1 },
        options: { delay: 2_500, attempts: 4, timeout: 9_000, lifo: true, priority: 2 },
      },
    ]);
    expect(await row(job!.id)).toMatchObject({
      state: 'delayed',
      priority: 2,
      lifo: true,
      run_at: String(START + 2_500),
      created_at: String(START),
      rung_at: null,
      max_attempts: 4,
      attempts: 0,
      timeout: '9000',
      ttl: null,
      version: '0',
      custom_id: null,
      group_id: null,
      group_order: null,
      unique_key: null,
    });
  });

  test('attempts default to 1', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
    expect((await row(job!.id)).max_attempts).toBe(1);
    expect(await t.store.getJob(job!.id)).toMatchObject({ attempts: 0, maxAttempts: 1 });
  });

  test('the payload holds the name, the data and the retry settings', async () => {
    const [job] = await t.store.enqueue([
      {
        queue: 'q',
        name: 'n',
        data: 'd',
        options: {
          backoff: { type: 'exponential', delay: 200, maxDelay: 5_000 },
          stallTimeout: 3_000,
          deduplication: { id: 'k', ttl: 1_000, extend: true },
          group: { id: 7, maxSize: 3 },
          removeOnComplete: true,
        },
      },
      { queue: 'q', data: 1, options: { backoff: 300 } },
      { queue: 'q', data: 1 },
    ]);
    const envelope = async (id: string) =>
      createMsgpackCodec().decode((await row(id)).payload) as Envelope;
    expect(await envelope(job!.id)).toEqual({
      v: 1,
      name: 'n',
      data: 'd',
      backoff: { type: 'exponential', delay: 200, maxDelay: 5_000 },
      stallTimeout: 3_000,
      dedup: { ttl: 1_000, extend: true },
      groupMaxSize: 3,
      removeOnComplete: true,
    });
    const jobs = await rows();
    const decoded = await Promise.all(jobs.map((r) => envelope(r.id)));
    expect(decoded.map((e) => e.backoff)).toContainEqual({ type: 'fixed', delay: 300 });
    expect(decoded.map((e) => e.backoff)).toContainEqual({ type: 'fixed', delay: 1_000 });
  });

  test('a batch is admitted in order, and ids sort in that order', async () => {
    const results = await t.store.enqueue(
      Array.from({ length: 50 }, (_, n) => ({ queue: 'q', data: n }))
    );
    expect(results.map((r) => r.created)).toEqual(Array(50).fill(true));
    const ids = results.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
    const page = await t.store.listJobs({ queue: 'q', limit: 100 });
    expect(page.items.map((r) => r.data)).toEqual(Array.from({ length: 50 }, (_, n) => n));
  });

  test('an empty call admits nothing and touches nothing', async () => {
    expect(await t.store.enqueue([])).toEqual([]);
  });

  describe('batch size', () => {
    test('1,000 jobs go in one call', async () => {
      const results = await t.store.enqueue(
        Array.from({ length: 1000 }, (_, n) => ({ queue: 'bulk', data: n }))
      );
      expect(results).toHaveLength(1000);
      expect(new Set(results.map((r) => r.id)).size).toBe(1000);
      expect((await rows()).length).toBe(1000);
      expect((await t.store.counts('bulk')).waiting).toBe(1000);
    });

    test('1,001 is refused with a clear error and nothing is admitted', async () => {
      const error = await t.store
        .enqueue(Array.from({ length: 1001 }, (_, n) => ({ queue: 'bulk', data: n })))
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(BatchTooLargeError);
      expect(error).toMatchObject({ size: 1001, limit: 1000 });
      expect(error.message).toMatch(/at most 1000 jobs per call, got 1001/);
      expect(await rows()).toHaveLength(0);
    });
  });
});
