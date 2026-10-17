import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { MAX_CLAIM } from '../src/index';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind, START } from './storeHelpers';

interface Row {
  id: string;
  state: string;
  attempts: number;
  started_at: string | null;
  rung_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: string | null;
  lease_renewals: number;
  version: string;
}

describeDb('claim: basics', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_group_state`;
    rewind(t);
  });

  const row = async (id: string) =>
    (await t.fresh.sql<Row[]>`SELECT * FROM qcloud_jobs WHERE id = ${id}`)[0]!;

  test('a claim leases the job to the owner and says so on the row', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', name: 'send', data: { n: 1 } }]);
    const [claimed, ...rest] = await t.store.claim('q', 'worker-a', 1);
    expect(rest).toEqual([]);
    expect(claimed).toMatchObject({
      id: job!.id,
      queue: 'q',
      name: 'send',
      data: { n: 1 },
      attempts: 0,
      leaseUntil: START + 30_000,
      lease: { jobId: job!.id, owner: 'worker-a' },
    });
    expect(claimed!.lease.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await row(job!.id)).toMatchObject({
      state: 'active',
      started_at: String(START),
      lease_owner: 'worker-a',
      lease_token: claimed!.lease.token,
      lease_until: String(START + 30_000),
      lease_renewals: 0,
      version: '1',
    });
    expect(await t.store.getJob(job!.id)).toMatchObject({
      state: 'active',
      lease: { owner: 'worker-a', until: START + 30_000 },
    });
  });

  test('a claim does not count an attempt', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { attempts: 3 } }]);
    await t.store.claim('q', 'w', 1);
    expect((await row(job!.id)).attempts).toBe(0);
    expect(await t.store.getJob(job!.id)).toMatchObject({ attempts: 0, maxAttempts: 3 });
  });

  test('a claim clears rung_at: the bell that led to it is spent', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
    await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 0 }]);
    expect((await row(job!.id)).rung_at).toBe(String(START));
    await t.store.claim('q', 'w', 1);
    expect((await row(job!.id)).rung_at).toBeNull();
  });

  test('a job is never claimed twice', async () => {
    await enqueueN(t.store, 3);
    const first = await t.store.claim('q', 'a', 2);
    const second = await t.store.claim('q', 'b', 5);
    const third = await t.store.claim('q', 'c', 5);
    expect([first.length, second.length, third.length]).toEqual([2, 1, 0]);
    expect(new Set([...first, ...second].map((job) => job.id)).size).toBe(3);
  });

  describe('how many jobs', () => {
    test('at most n, in one call', async () => {
      await enqueueN(t.store, 10);
      expect(await t.store.claim('q', 'w', 4)).toHaveLength(4);
      expect((await t.store.counts('q')).active).toBe(4);
    });

    test('an empty queue and a queue nobody has used give nothing', async () => {
      expect(await t.store.claim('empty', 'w', 5)).toEqual([]);
      await enqueueN(t.store, 1, {}, 'other');
      expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    });

    test('a claim on a queue with no state row creates one, as upstream does', async () => {
      await t.store.claim('fresh', 'w', 1);
      const rows = await t.fresh.sql`SELECT queue, paused FROM qcloud_queue_state`;
      expect([...rows]).toEqual([{ queue: 'fresh', paused: false }]);
    });

    test.each([0, -3, Number.NaN])('n = %p takes nothing', async (n) => {
      await enqueueN(t.store, 2);
      expect(await t.store.claim('q', 'w', n)).toEqual([]);
      expect((await t.store.counts('q')).waiting).toBe(2);
    });

    test('a fractional n is rounded down', async () => {
      await enqueueN(t.store, 5);
      expect(await t.store.claim('q', 'w', 2.9)).toHaveLength(2);
    });

    test(`n is clamped to ${MAX_CLAIM}`, async () => {
      await enqueueN(t.store, MAX_CLAIM + 5);
      expect(await t.store.claim('q', 'w', 1_000_000)).toHaveLength(MAX_CLAIM);
    });
  });

  describe('which jobs are claimable', () => {
    test('a delayed job waits for its run_at, and then needs no tick', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { delay: 5_000 } }]);
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
      t.clock.advance(4_999);
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
      t.clock.advance(1);
      expect((await row(job!.id)).state).toBe('delayed');
      const [claimed] = await t.store.claim('q', 'w', 1);
      expect(claimed!.id).toBe(job!.id);
      expect((await row(job!.id)).state).toBe('active');
    });

    test('finished and active jobs are not claimable', async () => {
      const ids = await enqueueN(t.store, 3);
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${ids[0]!}`;
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'failed' WHERE id = ${ids[1]!}`;
      await t.fresh
        .sql`UPDATE qcloud_jobs SET state = 'active', lease_until = ${START + 5} WHERE id = ${ids[2]!}`;
      expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    });

    test('a bell for a job that already finished claims nothing', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      await t.store.markRung([{ jobId: job!.id, deliverAfterMs: 0 }]);
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${job!.id}`;
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    });

    test('bells are fungible: a claim takes the next job, whichever job the bell named', async () => {
      const [a, b] = await enqueueN(t.store, 2);
      await t.store.markRung([{ jobId: b!, deliverAfterMs: 0 }]);
      const [claimed] = await t.store.claim('q', 'w', 1);
      expect(claimed!.id).toBe(a!);
    });

    test('a job whose lease expired is not claimable: recovery owns it', async () => {
      const [job] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
      await t.store.claim('q', 'w', 1);
      t.clock.advance(30_001);
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
      expect((await row(job!.id)).state).toBe('active');
    });
  });

  describe('the lease it grants', () => {
    test('leaseMs on the call overrides the store default', async () => {
      await enqueueN(t.store, 1);
      const [claimed] = await t.store.claim('q', 'w', 1, { leaseMs: 5_000 });
      expect(claimed!.leaseUntil).toBe(START + 5_000);
    });

    test('the store default comes from its leaseMs option', async () => {
      const short = t.another({ leaseMs: 1_000 });
      await enqueueN(t.store, 1);
      const [claimed] = await short.claim('q', 'w', 1);
      expect(claimed!.leaseUntil).toBe(START + 1_000);
    });

    test('a stall timeout shortens the lease', async () => {
      await enqueueN(t.store, 1, { stallTimeout: 3_000 });
      const [claimed] = await t.store.claim('q', 'w', 1);
      expect(claimed!.leaseUntil).toBe(START + 3_000);
    });

    test('a processing timeout caps the lease at started_at + timeout', async () => {
      await enqueueN(t.store, 1, { timeout: 2_000 });
      const [claimed] = await t.store.claim('q', 'w', 1);
      expect(claimed!.leaseUntil).toBe(START + 2_000);
    });

    test('each job gets its own token', async () => {
      await enqueueN(t.store, 4);
      const claimed = await t.store.claim('q', 'w', 4);
      expect(new Set(claimed.map((job) => job.lease.token)).size).toBe(4);
    });
  });

  describe('arguments', () => {
    test.each([
      ['an empty queue name', '', 'w'],
      ['a queue name with NUL', 'a\0b', 'w'],
      ['an empty owner', 'q', ''],
      ['an over-long owner', 'q', 'o'.repeat(257)],
    ])('%s is refused before anything is read', async (_label, queue, owner) => {
      await expect(t.store.claim(queue, owner, 1)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPTION',
      });
    });
  });
});
