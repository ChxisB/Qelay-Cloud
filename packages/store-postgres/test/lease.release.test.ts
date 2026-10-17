import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind, START } from './storeHelpers';

interface Row {
  state: string;
  priority: number;
  attempts: number;
  run_at: string;
  started_at: string | null;
  rung_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: string | null;
  lease_renewals: number;
  version: string;
}

describeDb('lease: release', () => {
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

  const row = async (id: string) =>
    (await t.fresh.sql<Row[]>`SELECT * FROM qcloud_jobs WHERE id = ${id}`)[0]!;

  async function claimOne(options: Parameters<typeof enqueueN>[2] = {}) {
    await enqueueN(t.store, 1, options);
    return (await t.store.claim('q', 'w', 1))[0]!;
  }

  test('gives the job back: claimable at once, no lease, no attempt counted', async () => {
    const job = await claimOne({ attempts: 3 });
    t.clock.advance(1_000);
    const outcome = await t.store.release(job.lease);
    expect(outcome.ok).toBe(true);
    expect(await row(job.id)).toMatchObject({
      state: 'waiting',
      attempts: 0,
      run_at: String(START),
      started_at: null,
      rung_at: null,
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      lease_renewals: 0,
      version: '2',
    });
    expect(await t.store.getJob(job.id)).toMatchObject({ state: 'waiting', lease: null });
  });

  test('returns the ring for the job, due now', async () => {
    const job = await claimOne();
    const { rings } = await t.store.release(job.lease);
    expect(rings).toEqual([{ bell: { namespace: 'test', queue: 'q', jobId: job.id }, dueInMs: 0 }]);
  });

  test('a prioritized job goes back to prioritized', async () => {
    const job = await claimOne({ priority: 4 });
    await t.store.release(job.lease);
    expect(await row(job.id)).toMatchObject({ state: 'prioritized', priority: 4 });
  });

  test('the job keeps its place in the queue', async () => {
    const [a, b, c] = await enqueueN(t.store, 3);
    t.clock.advance(5);
    const [first] = await t.store.claim('q', 'w', 1);
    expect(first!.id).toBe(a!);
    t.clock.advance(5);
    await t.store.release(first!.lease);
    const next = await t.store.claim('q', 'w', 3);
    expect(next.map((job) => job.id)).toEqual([a!, b!, c!]);
  });

  test('a LIFO job is still the newest', async () => {
    const [old, newest] = await enqueueN(t.store, 2, { lifo: true });
    const [taken] = await t.store.claim('q', 'w', 1);
    expect(taken!.id).toBe(newest!);
    await t.store.release(taken!.lease);
    const [again] = await t.store.claim('q', 'w', 1);
    expect(again!.id).toBe(newest!);
    expect(old).toBeDefined();
  });

  test('a job that was delayed and claimed after its run_at returns with that run_at', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { delay: 2_000 } }]);
    t.clock.advance(5_000);
    const [claimed] = await t.store.claim('q', 'w', 1);
    t.clock.advance(1_000);
    await t.store.release(claimed!.lease);
    expect(await row(job!.id)).toMatchObject({ state: 'waiting', run_at: String(START + 2_000) });
  });

  describe('the fence', () => {
    test('a wrong token changes nothing', async () => {
      const job = await claimOne();
      const before = await row(job.id);
      expect(await t.store.release({ ...job.lease, token: 'nope' })).toEqual({
        ok: false,
        rings: [],
      });
      expect(await row(job.id)).toEqual(before);
    });

    test('a lease that has expired is refused, so recovery counts the attempt', async () => {
      const job = await claimOne();
      t.clock.advance(30_000);
      expect(await t.store.release(job.lease)).toEqual({ ok: false, rings: [] });
      expect((await row(job.id)).state).toBe('active');
    });

    test('a release is allowed 1 ms before the lease expires', async () => {
      const job = await claimOne();
      t.clock.advance(29_999);
      expect((await t.store.release(job.lease)).ok).toBe(true);
    });

    test('a second release of the same lease is refused', async () => {
      const job = await claimOne();
      expect((await t.store.release(job.lease)).ok).toBe(true);
      expect(await t.store.release(job.lease)).toEqual({ ok: false, rings: [] });
      expect((await row(job.id)).version).toBe('2');
    });

    test('the old lease cannot release a job that was claimed again', async () => {
      const job = await claimOne();
      await t.store.release(job.lease);
      const [again] = await t.store.claim('q', 'x', 1);
      expect((await t.store.release(job.lease)).ok).toBe(false);
      expect((await row(job.id)).lease_owner).toBe('x');
      expect((await t.store.release(again!.lease)).ok).toBe(true);
    });

    test('unknown job, empty token, other namespace', async () => {
      const job = await claimOne();
      expect((await t.store.release({ jobId: 'nope', token: 'x', owner: 'w' })).ok).toBe(false);
      expect((await t.store.release({ ...job.lease, token: '' })).ok).toBe(false);
      expect((await t.another({ namespace: 'other' }).release(job.lease)).ok).toBe(false);
      expect((await row(job.id)).state).toBe('active');
    });

    test('a finished job cannot be released', async () => {
      const job = await claimOne();
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${job.id}`;
      expect((await t.store.release(job.lease)).ok).toBe(false);
      expect((await row(job.id)).state).toBe('completed');
    });
  });

  test('two releases of one lease at once: exactly one wins', async () => {
    for (let round = 0; round < 30; round++) {
      await t.fresh.sql`TRUNCATE qcloud_jobs`;
      const job = await claimOne();
      const results = await Promise.all([t.store.release(job.lease), t.store.release(job.lease)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect((await row(job.id)).version).toBe('2');
    }
  });
});
