import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ClaimedJob } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { PostgresStore } from '../src/postgresStore';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

const CLAIMERS = 8;

describeDb('claim: concurrent claimers', () => {
  let t: TestStore;
  let claimers: PostgresStore[];
  beforeAll(async () => {
    t = await openTestStore({ poolSize: 16 });
    claimers = Array.from({ length: CLAIMERS }, () => t.another());
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_group_state`;
    rewind(t);
  });

  /** Every claimer claims `batch` jobs at a time until it is given nothing `quiet` times running. */
  async function drain(batch: number, quiet = 2): Promise<ClaimedJob[][]> {
    return Promise.all(
      claimers.map(async (store, index) => {
        const mine: ClaimedJob[] = [];
        for (let empty = 0; empty < quiet;) {
          const got = await store.claim('q', `claimer-${index}`, batch);
          mine.push(...got);
          empty = got.length === 0 ? empty + 1 : 0;
        }
        return mine;
      })
    );
  }

  test(`${CLAIMERS} claimers take 5,000 jobs and every job exactly once`, async () => {
    const ids = await enqueueN(t.store, 5_000);
    const taken = await drain(50);
    const all = taken.flat();
    expect(all).toHaveLength(5_000);
    expect(new Set(all.map((job) => job.id))).toEqual(new Set(ids));
    expect(new Set(all.map((job) => job.lease.token)).size).toBe(5_000);
    // Each job carries the owner that claimed it.
    taken.forEach((mine, index) => {
      for (const job of mine) expect(job.lease.owner).toBe(`claimer-${index}`);
    });
    const rows = await t.fresh.sql`
      SELECT count(*)::int AS active, count(DISTINCT lease_token)::int AS tokens
      FROM qcloud_jobs WHERE state = 'active'`;
    expect(rows[0]).toEqual({ active: 5_000, tokens: 5_000 });
  });

  test('the work is shared: no claimer is shut out by the others', async () => {
    await enqueueN(t.store, 2_000);
    const taken = await drain(10);
    for (const mine of taken) expect(mine.length).toBeGreaterThan(0);
  });

  test('in priority order: the highest priorities are all taken before any lower one', async () => {
    await enqueueN(t.store, 200, { priority: 1 });
    await enqueueN(t.store, 200, { priority: 9 });
    const first = (await Promise.all(claimers.map((store) => store.claim('q', 'w', 25)))).flat();
    expect(first).toHaveLength(200);
    const rows = await t.fresh.sql`
      SELECT priority, count(*)::int AS n FROM qcloud_jobs WHERE state = 'active' GROUP BY priority`;
    expect([...rows]).toEqual([{ priority: 9, n: 200 }]);
  });

  describe('limits are enforced inside the claim, whoever else is claiming', () => {
    test('concurrency: with room for 3, eight claimers asking for 3 each get 3 jobs between them', async () => {
      await enqueueN(t.store, 200);
      await t.store.setConcurrencyLimit('q', 3);
      for (let round = 0; round < 5; round++) {
        await Promise.all(claimers.map((store) => store.claim('q', 'w', 3)));
      }
      expect((await t.store.counts('q')).active).toBe(3);
    });

    test('rate: with 10 per window, eight claimers get 10 jobs between them, however many windows they ask in', async () => {
      await enqueueN(t.store, 200);
      await t.store.setRateLimit('q', { max: 10, durationMs: 60_000 });
      const got = (
        await Promise.all(
          claimers.map(async (store) => {
            const mine: ClaimedJob[] = [];
            for (let round = 0; round < 5; round++) mine.push(...(await store.claim('q', 'w', 4)));
            return mine;
          })
        )
      ).flat();
      expect(got).toHaveLength(10);
      const rows = await t.fresh.sql`SELECT rate_count FROM qcloud_queue_state WHERE queue = 'q'`;
      expect(rows[0]!.rate_count).toBe(10);
    });

    test('concurrency under churn: claimed and given back at once, the committed active count never passes the limit', async () => {
      await enqueueN(t.store, 300);
      await t.store.setConcurrencyLimit('q', 3);
      let peak = 0;
      let claims = 0;
      let running = true;
      const sampler = (async () => {
        while (running) {
          const [row] = await t.fresh.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM qcloud_jobs WHERE state = 'active'`;
          peak = Math.max(peak, row!.n);
        }
      })();
      await Promise.all(
        claimers.map(async (store) => {
          for (let round = 0; round < 25; round++) {
            for (const job of await store.claim('q', 'w', 2)) {
              claims++;
              await store.release(job.lease);
            }
          }
        })
      );
      running = false;
      await sampler;
      expect(claims).toBeGreaterThan(20);
      expect(peak).toBeLessThanOrEqual(3);
    });
  });

  describe('groups', () => {
    test('a group concurrency of 1 holds with eight claimers at once', async () => {
      const jobs = ['a', 'b', 'c'].flatMap((group) =>
        Array.from({ length: 20 }, (_, i) => ({
          queue: 'q',
          data: `${group}${i}`,
          options: { group: { id: group } },
        }))
      );
      await t.store.enqueue(jobs);
      const got = (
        await Promise.all(
          claimers.map((store) => store.claim('q', 'w', 5, { group: { concurrency: 1 } }))
        )
      ).flat();
      expect(got).toHaveLength(3);
      expect(new Set(got.map((job) => String(job.data).slice(0, 1)))).toEqual(
        new Set(['a', 'b', 'c'])
      );
    });
  });

  test('a mix of claims, heartbeats, releases, pauses and limit changes ends consistent and without a deadlock error', async () => {
    const total = 600;
    await t.store.enqueue(
      Array.from({ length: total }, (_, i) => ({
        queue: 'q',
        data: i,
        options: i % 3 === 0 ? { group: { id: `g${i % 4}` } } : { priority: i % 5 },
      }))
    );
    let running = true;
    const toggler = (async () => {
      for (let i = 0; running; i++) {
        await t.store.pause('q');
        await t.store.resume('q');
        await t.store.setConcurrencyLimit('q', i % 2 === 0 ? 4 : null);
        await t.store.setRateLimit('q', i % 3 === 0 ? { max: 50, durationMs: 5 } : null);
      }
    })();
    const done = new Set<string>();
    await Promise.all(
      claimers.map(async (store, index) => {
        for (let round = 0; round < 30; round++) {
          for (const job of await store.claim('q', `w${index}`, 6, { group: { concurrency: 2 } })) {
            expect(await store.heartbeat(job.lease)).toBe(true);
            expect(done.has(job.id)).toBe(false);
            done.add(job.id);
            if (round % 2 === 0) {
              done.delete(job.id);
              expect((await store.release(job.lease)).ok).toBe(true);
            }
          }
        }
      })
    );
    running = false;
    await toggler;
    const rows = await t.fresh.sql`
      SELECT state, count(*)::int AS n FROM qcloud_jobs GROUP BY state ORDER BY state`;
    const byState = Object.fromEntries(
      rows.map((row: { state: string; n: number }) => [row.state, row.n])
    );
    expect((byState.active ?? 0) + (byState.waiting ?? 0) + (byState.prioritized ?? 0)).toBe(total);
    expect(byState.active ?? 0).toBe(done.size);
  });
});
