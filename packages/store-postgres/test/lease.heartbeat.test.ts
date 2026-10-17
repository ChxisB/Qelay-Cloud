import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind, START } from './storeHelpers';

interface Row {
  state: string;
  lease_until: string | null;
  lease_renewals: number;
  version: string;
}

describeDb('lease: heartbeat', () => {
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
    (
      await t.fresh.sql<
        Row[]
      >`SELECT state, lease_until, lease_renewals, version FROM qcloud_jobs WHERE id = ${id}`
    )[0]!;

  async function claimOne(options: Parameters<typeof enqueueN>[2] = {}, leaseMs?: number) {
    await enqueueN(t.store, 1, options);
    const [job] = await t.store.claim('q', 'w', 1, leaseMs === undefined ? undefined : { leaseMs });
    return job!;
  }

  test('extends the lease to now + the lease length, and counts the renewal', async () => {
    const job = await claimOne();
    t.clock.advance(10_000);
    expect(await t.store.heartbeat(job.lease)).toBe(true);
    expect(await row(job.id)).toMatchObject({
      state: 'active',
      lease_until: String(START + 10_000 + 30_000),
      lease_renewals: 1,
      version: '2',
    });
    t.clock.advance(10_000);
    expect(await t.store.heartbeat(job.lease)).toBe(true);
    expect((await row(job.id)).lease_renewals).toBe(2);
  });

  test('is visible through getJob', async () => {
    const job = await claimOne();
    t.clock.advance(5_000);
    await t.store.heartbeat(job.lease);
    expect((await t.store.getJob(job.id))!.lease).toEqual({ owner: 'w', until: START + 35_000 });
  });

  test('never shortens a lease that is longer already', async () => {
    const job = await claimOne({}, 120_000);
    t.clock.advance(1_000);
    expect(await t.store.heartbeat(job.lease)).toBe(true);
    expect((await row(job.id)).lease_until).toBe(String(START + 120_000));
  });

  describe('the fence', () => {
    test('a wrong token is refused and changes nothing', async () => {
      const job = await claimOne();
      const before = await row(job.id);
      expect(await t.store.heartbeat({ ...job.lease, token: 'not-the-token' })).toBe(false);
      expect(await row(job.id)).toEqual(before);
    });

    test('a token of another job is refused', async () => {
      const [first, second] = await (async () => {
        await enqueueN(t.store, 2);
        return t.store.claim('q', 'w', 2);
      })();
      expect(await t.store.heartbeat({ ...first!.lease, jobId: second!.id })).toBe(false);
    });

    test('an unknown job is refused', async () => {
      expect(await t.store.heartbeat({ jobId: 'nope', token: 'x', owner: 'w' })).toBe(false);
    });

    test.each([
      ['an empty token', { jobId: 'j', token: '', owner: 'w' }],
      ['an empty job id', { jobId: '', token: 't', owner: 'w' }],
    ])('%s is refused', async (_label, lease) => {
      expect(await t.store.heartbeat(lease)).toBe(false);
    });

    test('a lease of another namespace is refused', async () => {
      const job = await claimOne();
      const other = t.another({ namespace: 'other' });
      expect(await other.heartbeat(job.lease)).toBe(false);
      expect((await row(job.id)).lease_renewals).toBe(0);
    });

    test('a lease is renewed up to 1 ms before it expires, and not at expiry', async () => {
      const job = await claimOne();
      t.clock.advance(29_999);
      expect(await t.store.heartbeat(job.lease)).toBe(true);
      t.clock.advance(30_000);
      expect(await t.store.heartbeat(job.lease)).toBe(false);
    });

    test('an expired lease is refused, even if nobody has recovered the job yet', async () => {
      const job = await claimOne();
      t.clock.advance(30_000);
      expect(await t.store.heartbeat(job.lease)).toBe(false);
      expect(await row(job.id)).toMatchObject({ state: 'active', lease_renewals: 0 });
    });

    test('a job that is not active is refused', async () => {
      const job = await claimOne();
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${job.id}`;
      expect(await t.store.heartbeat(job.lease)).toBe(false);
    });

    test('the token of a job given back no longer renews it', async () => {
      const job = await claimOne();
      await t.store.release(job.lease);
      expect(await t.store.heartbeat(job.lease)).toBe(false);
      const [again] = await t.store.claim('q', 'w', 1);
      expect(again!.id).toBe(job.id);
      expect(await t.store.heartbeat(job.lease)).toBe(false);
      expect(await t.store.heartbeat(again!.lease)).toBe(true);
    });
  });

  describe('timeouts', () => {
    test('a renewal never moves the lease past started_at + timeout', async () => {
      const job = await claimOne({ timeout: 5_000 });
      expect(job.leaseUntil).toBe(START + 5_000);
      t.clock.advance(4_000);
      expect(await t.store.heartbeat(job.lease)).toBe(true);
      expect((await row(job.id)).lease_until).toBe(String(START + 5_000));
    });

    test('agrees with the claim: the same cap, from the same started_at', async () => {
      const job = await claimOne({ timeout: 8_000 });
      for (const step of [1_000, 1_000, 1_000]) {
        t.clock.advance(step);
        await t.store.heartbeat(job.lease);
        expect((await row(job.id)).lease_until).toBe(String(job.leaseUntil));
      }
    });

    test('a job past its processing deadline is not renewed', async () => {
      const job = await claimOne({ timeout: 5_000 });
      await t.fresh
        .sql`UPDATE qcloud_jobs SET lease_until = ${START + 60_000} WHERE id = ${job.id}`;
      t.clock.advance(5_000);
      expect(await t.store.heartbeat(job.lease)).toBe(false);
    });

    test('a renewal is not shortened to the stall timeout, only a claim is', async () => {
      const job = await claimOne({ stallTimeout: 3_000 });
      expect(job.leaseUntil).toBe(START + 3_000);
      t.clock.advance(2_000);
      expect(await t.store.heartbeat(job.lease)).toBe(true);
      expect((await row(job.id)).lease_until).toBe(String(START + 2_000 + 30_000));
    });
  });

  test('a heartbeat racing a release leaves a consistent row', async () => {
    for (let round = 0; round < 40; round++) {
      await t.fresh.sql`TRUNCATE qcloud_jobs`;
      const job = await claimOne();
      const [beat, released] = await Promise.all([
        t.store.heartbeat(job.lease),
        t.store.release(job.lease),
      ]);
      expect(released.ok).toBe(true);
      expect(typeof beat).toBe('boolean');
      expect(await row(job.id)).toMatchObject({ state: 'waiting', lease_until: null });
      expect(await t.store.heartbeat(job.lease)).toBe(false);
    }
  });
});
