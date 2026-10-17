import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { EnqueuedJob, NewJob } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { GroupFullError } from '../src/errors';
import type { PostgresStore } from '../src/postgresStore';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const LIVE = `('waiting','prioritized','delayed','waiting-children','active')`;
const SEED = 20_261_014;

/** Small seeded generator, so a failing race replays with the same inputs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

/** Runs `tasks` with at most `width` in flight. */
async function inWaves<T>(tasks: ReadonlyArray<() => Promise<T>>, width: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < tasks.length) {
        const at = next++;
        results[at] = await tasks[at]!();
      }
    })
  );
  return results;
}

describeDb('enqueue: races', () => {
  let t: TestStore;
  let stores: PostgresStore[];
  beforeAll(async () => {
    t = await openTestStore({ poolSize: 16 });
    stores = [t.store, ...Array.from({ length: 7 }, () => t.another())];
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs`;
  });

  const sql = () => t.fresh.sql;
  const pick = (random: () => number) => stores[Math.floor(random() * stores.length)]!;
  const liveHolders = async (key: string) =>
    (
      await sql()<Array<{ id: string }>>`
      SELECT id FROM qcloud_jobs WHERE unique_key = ${key} AND state IN ${sql().unsafe(LIVE)}`
    ).length;

  test('1,000 racing dedup enqueues each leave exactly one live holder', async () => {
    const random = mulberry32(SEED);
    const races = Array.from({ length: 1000 }, (_, race) => async () => {
      const key = `dedup-${race}`;
      const callers = 2 + Math.floor(random() * 4);
      const job = (caller: number): NewJob => ({
        queue: 'q',
        data: caller,
        options: { deduplication: { id: key } },
      });
      const stores_ = Array.from({ length: callers }, () => pick(random));
      const results = await Promise.all(
        stores_.map((store, caller) => store.enqueue([job(caller)]))
      );
      const flat = results.map((r) => r[0]!);
      expect(flat.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(flat.map((r) => r.id)).size).toBe(1);
      expect(await liveHolders(key)).toBe(1);
    });
    await inWaves(races, 8);
    expect(
      (await sql()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_jobs`)[0]!.n
    ).toBe(1000);
  }, 120_000);

  test('1,000 racing custom-id enqueues each leave exactly one row', async () => {
    const random = mulberry32(SEED + 1);
    const races = Array.from({ length: 1000 }, (_, race) => async () => {
      const id = `custom-${race}`;
      const callers = 2 + Math.floor(random() * 4);
      const results = await Promise.all(
        Array.from({ length: callers }, (_, caller) =>
          pick(random).enqueue([{ queue: 'q', data: caller, options: { jobId: id } }])
        )
      );
      const flat = results.map((r) => r[0]!);
      expect(flat.filter((r) => r.created)).toHaveLength(1);
      expect(flat.every((r) => r.id === id)).toBe(true);
    });
    await inWaves(races, 8);
    expect(
      (await sql()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_jobs`)[0]!.n
    ).toBe(1000);
  }, 120_000);

  test('racing replaces leave exactly one live holder, and it is one a caller was told it created', async () => {
    const random = mulberry32(SEED + 2);
    const races = Array.from({ length: 200 }, (_, race) => async () => {
      const key = `replace-${race}`;
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, caller) =>
          pick(random).enqueue([
            {
              queue: 'q',
              data: caller,
              options: { deduplication: { id: key, replace: caller % 2 === 0 } },
            },
          ])
        )
      );
      const survivors = await sql()<Array<{ id: string }>>`
        SELECT id FROM qcloud_jobs WHERE unique_key = ${key} AND state IN ${sql().unsafe(LIVE)}`;
      expect(survivors).toHaveLength(1);
      const created = results.map((r) => r[0]!).filter((r) => r.created);
      expect(created.map((r) => r.id)).toContain(survivors[0]!.id);
      const rows = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM qcloud_jobs WHERE queue = 'q' AND unique_key = ${key}`;
      expect(rows[0]!.n).toBe(1);
    });
    await inWaves(races, 8);
  }, 120_000);

  test('racing reuse of a finished custom id inserts one fresh job', async () => {
    const random = mulberry32(SEED + 3);
    const races = Array.from({ length: 100 }, (_, race) => async () => {
      const id = `again-${race}`;
      await stores[0]!.enqueue([{ queue: 'q', data: 'old', options: { jobId: id } }]);
      await sql()`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${id}`;
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, caller) =>
          pick(random).enqueue([{ queue: 'q', data: caller, options: { jobId: id } }])
        )
      );
      expect(results.map((r) => r[0]!.created).filter(Boolean)).toHaveLength(1);
      const rows = await sql()<
        Array<{ state: string }>
      >`SELECT state FROM qcloud_jobs WHERE id = ${id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('waiting');
    });
    await inWaves(races, 8);
  }, 120_000);

  test('batches that share keys in opposite orders finish without a deadlock', async () => {
    const random = mulberry32(SEED + 4);
    const keys = Array.from({ length: 12 }, (_, n) => n);
    const batch = (order: number[]): NewJob[] =>
      order.map((n) => ({
        queue: n % 2 === 0 ? 'a' : 'b',
        data: n,
        options:
          n % 3 === 0
            ? { jobId: `id-${n}`, deduplication: { id: `key-${n}` } }
            : n % 3 === 1
              ? { deduplication: { id: `key-${n}` } }
              : { jobId: `id-${n}`, group: { id: `g-${n % 4}`, maxSize: 1000 } },
      }));
    const rounds = Array.from({ length: 40 }, () => async () => {
      const orders = Array.from({ length: 6 }, () => shuffled(keys, random));
      await Promise.all(orders.map((order) => pick(random).enqueue(batch(order))));
    });
    await inWaves(rounds, 4);
    const rows = await sql()<Array<{ key: string | null; n: number }>>`
      SELECT unique_key AS key, count(*)::int AS n FROM qcloud_jobs
      WHERE unique_key IS NOT NULL GROUP BY unique_key`;
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.n === 1)).toBe(true);
    const ids = await sql()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_jobs WHERE custom_id IS NOT NULL`;
    expect(ids[0]!.n).toBe(8);
  }, 120_000);

  test('a group with maxSize admits exactly maxSize jobs when callers race for the room', async () => {
    const random = mulberry32(SEED + 5);
    for (let round = 0; round < 20; round++) {
      const group = { id: `cap-${round}`, maxSize: 5 };
      const outcomes = await Promise.allSettled(
        Array.from({ length: 16 }, () =>
          pick(random).enqueue([{ queue: 'q', data: round, options: { group } }])
        )
      );
      const admitted = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o) => o.status === 'rejected');
      expect(admitted).toHaveLength(5);
      expect(refused).toHaveLength(11);
      expect(
        refused.every((o) => (o as PromiseRejectedResult).reason instanceof GroupFullError)
      ).toBe(true);
      const rows = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM qcloud_jobs WHERE group_id = ${group.id}`;
      expect(rows[0]!.n).toBe(5);
    }
  }, 120_000);

  test('an exclusive lifecycle lock on a queue holds enqueues back, and they finish when it is released', async () => {
    const { advisoryLockName } = await import('../src/store/locks');
    const name = advisoryLockName('queue-lifecycle', 'test', 'held');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = sql().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
      locked();
      await held;
    });
    await lockTaken;
    let finished = false;
    const waiting: Promise<EnqueuedJob[]> = stores[1]!
      .enqueue([{ queue: 'held', data: 1 }])
      .then((result) => {
        finished = true;
        return result;
      });
    await Bun.sleep(300);
    expect(finished).toBe(false);
    const other = await stores[2]!.enqueue([{ queue: 'free', data: 1 }]);
    expect(other[0]!.created).toBe(true);
    release();
    await holder;
    expect((await waiting)[0]!.created).toBe(true);
  });
});
