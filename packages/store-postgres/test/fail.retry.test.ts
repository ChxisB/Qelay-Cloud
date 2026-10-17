import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, metric, readJob, recording, resetTables, retryStateOf } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const HOUR = 3_600_000;
const boom = { message: 'boom', unrecoverable: false } as const;

describeDb('fail: a retry', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000, ringWindowMs: HOUR });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
    log.failWith(null);
  });

  test('counts the attempt and puts the job back after its backoff, with the lease and bell cleared', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
    t.clock.advance(1_000);
    const outcome = await t.store.fail(job.lease, boom);
    expect(outcome.ok).toBe(true);
    expect(await readJob(t, job.id)).toMatchObject({
      state: 'delayed',
      attempts: 1,
      run_at: String(START + 1_000 + 5_000),
      rung_at: null,
      started_at: null,
      completed_at: null,
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      lease_renewals: 0,
      error: null,
      failure_reason: null,
      dlq_entry: null,
    });
  });

  test('returns the ring for the retry, due after the backoff', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
    const { rings } = await t.store.fail(job.lease, boom);
    expect(rings).toEqual([
      { bell: { namespace: 'test', queue: 'q', jobId: job.id }, dueInMs: 5_000 },
    ]);
  });

  test('a backoff of 0 makes the job claimable at once, with a ring due now', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0 });
    const { rings } = await t.store.fail(job.lease, boom);
    expect(rings).toEqual([{ bell: { namespace: 'test', queue: 'q', jobId: job.id }, dueInMs: 0 }]);
    expect((await readJob(t, job.id))!.state).toBe('waiting');
    expect((await t.store.claim('q', 'w2', 1)).map((claimed) => claimed.id)).toEqual([job.id]);
  });

  test('a prioritized job goes back to prioritized', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0, priority: 3 });
    await t.store.fail(job.lease, boom);
    expect((await readJob(t, job.id))!.state).toBe('prioritized');
  });

  test('is not claimable before the backoff and is after it', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 5_000 });
    await t.store.fail(job.lease, boom);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    t.clock.advance(4_999);
    expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    t.clock.advance(1);
    const [again] = await t.store.claim('q', 'w', 1);
    expect(again!.id).toBe(job.id);
    expect(again!.attempts).toBe(1);
  });

  test('exponential backoff doubles from twice the base on each retry', async () => {
    const job = await claimOne(t, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 1_000 },
    });
    const delays: number[] = [];
    let lease = job.lease;
    for (let retry = 0; retry < 3; retry++) {
      const before = t.clock.now();
      await t.store.fail(lease, boom);
      delays.push(Number((await readJob(t, job.id))!.run_at) - before);
      t.clock.advance(delays.at(-1)!);
      lease = (await t.store.claim('q', 'w', 1))[0]!.lease;
    }
    expect(delays).toEqual([2_000, 4_000, 8_000]);
  });

  test('a backoff longer than the ring window returns no ring and leaves the job for the tick', async () => {
    const job = await claimOne(t, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 2 * HOUR, maxDelay: 3 * HOUR },
    });
    const outcome = await t.store.fail(job.lease, boom);
    expect(outcome).toEqual({ ok: true, rings: [] });
    expect((await readJob(t, job.id))!.state).toBe('delayed');
  });

  test('a store with no ring window rings only a retry that is due now', async () => {
    const plain = t.another({ ringWindowMs: 0 });
    const delayed = await claimOne({ store: plain }, { attempts: 2, backoff: 1_000 });
    expect(await plain.fail(delayed.lease, boom)).toEqual({ ok: true, rings: [] });
    const now = await claimOne({ store: plain }, { attempts: 2, backoff: 0 }, 'other');
    expect((await plain.fail(now.lease, boom)).rings).toHaveLength(1);
  });

  test('a retry is journaled as retried with the error, in the state the job is now in', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 1_000 });
    log.events.length = 0;
    await t.store.fail(job.lease, { message: 'it broke', unrecoverable: false });
    expect(log.events).toEqual([
      { type: 'retried', queue: 'q', jobId: job.id, state: 'delayed', error: 'it broke' },
    ]);
  });

  test('a retry counts no failed metric', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0 });
    await t.store.fail(job.lease, boom);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
  });

  test('keeps an attempt record of each failure, with its time, error and duration', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    t.clock.advance(400);
    await t.store.fail(job.lease, { message: 'first', unrecoverable: false });
    const [second] = await t.store.claim('q', 'w', 1);
    t.clock.advance(900);
    await t.store.fail(second!.lease, { message: 'second', unrecoverable: false });
    const state = retryStateOf(await readJob(t, job.id));
    expect(state.stalls).toBe(0);
    expect(state.attempts).toEqual([
      {
        attempt: 1,
        startedAt: START,
        failedAt: START + 400,
        reason: 'explicit_fail',
        error: 'first',
        durationMs: 400,
      },
      {
        attempt: 2,
        startedAt: START + 400,
        failedAt: START + 1_300,
        reason: 'explicit_fail',
        error: 'second',
        durationMs: 900,
      },
    ]);
  });

  test('the attempt history keeps the newest 20 records and the column the true count', async () => {
    const job = await claimOne(t, { attempts: 30, backoff: 0 });
    let lease = job.lease;
    for (let n = 1; n <= 25; n++) {
      await t.store.fail(lease, { message: `failure ${n}`, unrecoverable: false });
      lease = (await t.store.claim('q', 'w', 1))[0]!.lease;
    }
    const row = await readJob(t, job.id);
    expect(row!.attempts).toBe(25);
    const { attempts } = retryStateOf(row);
    expect(attempts).toHaveLength(20);
    expect(attempts[0]!.attempt).toBe(6);
    expect(attempts.at(-1)!.attempt).toBe(25);
  });

  test('each of the failure’s writes bumps the version', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0 });
    const before = Number((await readJob(t, job.id))!.version);
    await t.store.fail(job.lease, boom);
    expect(Number((await readJob(t, job.id))!.version)).toBe(before + 1);
  });
});

describeDb('fail: a lease that no longer holds', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('a stale token is refused and changes nothing, counts no attempt', async () => {
    const job = await claimOne(t, { attempts: 3 });
    const before = await readJob(t, job.id);
    expect(await t.store.fail({ ...job.lease, token: 'stale' }, boom)).toEqual({
      ok: false,
      rings: [],
    });
    expect(await readJob(t, job.id)).toEqual(before!);
  });

  test('a malformed lease or failure info is handled without throwing', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    expect(await t.store.fail({ jobId: '', token: 'x', owner: 'w' }, boom)).toMatchObject({
      ok: false,
    });
    // A handler that throws a non-error gives no usable message: the failure still counts.
    expect(await t.store.fail(job.lease, undefined as never)).toMatchObject({ ok: true });
    const row = await readJob(t, job.id);
    expect(row!.attempts).toBe(1);
    expect(retryStateOf(row).attempts[0]!.error).toBe('');
  });

  test('a lease past its time is refused: recovery owns the job from then on', async () => {
    const job = await claimOne(t, { attempts: 3 });
    t.clock.advance(30_000);
    expect(await t.store.fail(job.lease, boom)).toEqual({ ok: false, rings: [] });
    expect((await readJob(t, job.id))!.attempts).toBe(0);
  });

  test('failing twice with one lease counts the attempt once', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    expect(await t.store.fail(job.lease, boom)).toMatchObject({ ok: true });
    expect(await t.store.fail(job.lease, boom)).toMatchObject({ ok: false });
    expect((await readJob(t, job.id))!.attempts).toBe(1);
  });
});
