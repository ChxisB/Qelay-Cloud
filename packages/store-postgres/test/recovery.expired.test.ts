import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Ring } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TerminalChange } from '../src/store/context';
import {
  blobOf,
  claimOne,
  expireLease,
  metric,
  readJob,
  recording,
  resetTables,
  retryStateOf,
} from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const LEASE = 30_000;

describeDb('recovery: an expired lease', () => {
  const log = recording();
  const changes: TerminalChange[] = [];
  let hookRings: Ring[] = [];
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({
      recorder: log.recorder,
      leaseMs: LEASE,
      ringWindowMs: 3_600_000,
      onTerminal: async (_tx, batch) => {
        changes.push(...batch);
        return hookRings;
      },
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
    changes.length = 0;
    hookRings = [];
  });

  test('counts an attempt and retries the job after its backoff, with the lease and bell cleared', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
    expireLease(t, job, 2_000);
    const report = await t.store.recoverExpired();
    expect(report).toEqual({
      recovered: 1,
      more: false,
      rings: [{ bell: { namespace: 'test', queue: 'q', jobId: job.id }, dueInMs: 5_000 }],
    });
    expect(await readJob(t, job.id)).toMatchObject({
      state: 'delayed',
      attempts: 1,
      run_at: String(job.leaseUntil + 2_000 + 5_000),
      rung_at: null,
      started_at: null,
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      lease_renewals: 0,
      error: null,
      failure_reason: null,
    });
  });

  test('keeps a stalled attempt record and one stall', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    expireLease(t, job, 500);
    await t.store.recoverExpired();
    const state = retryStateOf(await readJob(t, job.id));
    expect(state.stalls).toBe(1);
    expect(state.attempts).toEqual([
      {
        attempt: 1,
        startedAt: START,
        failedAt: START + LEASE + 500,
        reason: 'stalled',
        error: 'Job lease expired',
        durationMs: LEASE + 500,
      },
    ]);
  });

  test('journals a stalled event, not a failure', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
    expireLease(t, job);
    log.events.length = 0;
    await t.store.recoverExpired();
    expect(log.events).toEqual([
      {
        type: 'stalled',
        queue: 'q',
        jobId: job.id,
        state: 'delayed',
        error: 'Job lease expired',
      },
    ]);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
    expect(changes).toEqual([]);
  });

  test('is claimable again after the backoff, and a claim counts no further attempt', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
    expireLease(t, job);
    await t.store.recoverExpired();
    expect(await t.store.claim('q', 'w2', 1)).toEqual([]);
    t.clock.advance(5_000);
    const [again] = await t.store.claim('q', 'w2', 1);
    expect(again).toMatchObject({ id: job.id, attempts: 1 });
  });

  test('the last attempt goes to the DLQ as max_attempts_exceeded and counts a failed metric', async () => {
    const job = await claimOne(t, { attempts: 1 });
    expireLease(t, job);
    log.events.length = 0;
    hookRings = [{ bell: { namespace: 'test', queue: 'q', jobId: 'parent' }, dueInMs: 0 }];
    const report = await t.store.recoverExpired();
    expect(report).toEqual({ recovered: 1, more: false, rings: hookRings });
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({
      state: 'failed',
      attempts: 1,
      failure_reason: 'max_attempts_exceeded',
      error: 'Job lease expired',
      lease_token: null,
      rung_at: null,
    });
    expect(blobOf(row)).toMatchObject({
      reason: 'max_attempts_exceeded',
      error: 'Job lease expired',
    });
    expect(changes).toEqual([
      {
        jobId: job.id,
        queue: 'q',
        parentId: null,
        outcome: 'failed',
        error: 'Job lease expired',
      },
    ]);
    expect(log.events).toEqual([
      { type: 'failed', queue: 'q', jobId: job.id, state: 'failed', error: 'Job lease expired' },
    ]);
    expect((await metric(t, 'q', 'failed')).total).toBe(1);
    expect(await t.store.listDlq('q')).toHaveLength(1);
  });

  test('removeOnFail deletes a job whose last attempt expired', async () => {
    const job = await claimOne(t, { attempts: 1, removeOnFail: true });
    expireLease(t, job);
    await t.store.recoverExpired();
    expect(await readJob(t, job.id)).toBeUndefined();
    expect((await metric(t, 'q', 'failed')).total).toBe(1);
  });

  test('a lease that has not expired is left alone, and one that expired this instant is taken', async () => {
    const job = await claimOne(t, { attempts: 3 });
    expireLease(t, job, -1);
    expect(await t.store.recoverExpired()).toMatchObject({ recovered: 0 });
    expect((await readJob(t, job.id))!.state).toBe('active');
    t.clock.advance(1);
    expect(await t.store.recoverExpired()).toMatchObject({ recovered: 1 });
  });

  test('a heartbeat keeps the job from being recovered', async () => {
    const job = await claimOne(t, { attempts: 3 });
    t.clock.advance(LEASE - 1_000);
    expect(await t.store.heartbeat(job.lease)).toBe(true);
    t.clock.advance(LEASE - 1_000);
    expect(await t.store.recoverExpired()).toMatchObject({ recovered: 0 });
    expect((await readJob(t, job.id))!.state).toBe('active');
  });

  test('only active jobs are recovered', async () => {
    const [pending] = await enqueueN(t.store, 1, { delay: 10 }, 'idle');
    const done = await claimOne(t);
    await t.store.complete(done.lease, 1);
    t.clock.advance(10 * LEASE);
    expect(await t.store.recoverExpired()).toMatchObject({ recovered: 0 });
    expect((await readJob(t, pending!))!.state).toBe('delayed');
  });

  test('takes at most the limit, oldest lease first, and says there is more', async () => {
    const jobs = [];
    for (let n = 0; n < 5; n++) {
      jobs.push(await claimOne(t, { attempts: 3, backoff: 0 }));
      t.clock.advance(10);
    }
    t.clock.advance(2 * LEASE);
    const first = await t.store.recoverExpired(2);
    expect(first).toMatchObject({ recovered: 2, more: true });
    const states = await Promise.all(jobs.map(async (job) => (await readJob(t, job.id))!.attempts));
    expect(states).toEqual([1, 1, 0, 0, 0]);
    expect(await t.store.recoverExpired(2)).toMatchObject({ recovered: 2, more: true });
    expect(await t.store.recoverExpired(2)).toMatchObject({ recovered: 1, more: false });
    expect(await t.store.recoverExpired(2)).toMatchObject({ recovered: 0, more: false });
  });

  test('a pass that finds nothing writes nothing', async () => {
    const before = await t.fresh.sql`SELECT * FROM qcloud_jobs`;
    expect(await t.store.recoverExpired()).toEqual({ recovered: 0, rings: [], more: false });
    expect(await t.fresh.sql`SELECT * FROM qcloud_jobs`).toEqual(before);
  });

  test('a journal failure rolls the whole pass back and the next pass recovers the job', async () => {
    const job = await claimOne(t, { attempts: 1 });
    expireLease(t, job);
    const before = await readJob(t, job.id);
    log.failWith(new Error('journal is down'));
    await expect(t.store.recoverExpired()).rejects.toThrow('journal is down');
    expect(await readJob(t, job.id)).toEqual(before!);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
    log.failWith(null);
    expect(await t.store.recoverExpired()).toMatchObject({ recovered: 1 });
  });
});
