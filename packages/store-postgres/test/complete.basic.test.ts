import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { StoreError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import {
  claimOne,
  codec,
  expireLease,
  metric,
  readJob,
  recording,
  resetTables,
} from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('complete: the happy path', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
    log.failWith(null);
  });

  test('stores the result, ends the lease and marks the job completed', async () => {
    const job = await claimOne(t, { attempts: 3 });
    t.clock.advance(1_234);
    const outcome = await t.store.complete(job.lease, { answer: 42, list: [1, 2] });
    expect(outcome).toEqual({ ok: true, rings: [] });
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({
      state: 'completed',
      attempts: 0,
      completed_at: String(START + 1_234),
      rung_at: null,
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      error: null,
      failure_reason: null,
      dlq_entry: null,
      dlq_retry_state: null,
      version: '2',
    });
    expect(codec.decode(row.result!)).toEqual({ answer: 42, list: [1, 2] });
    expect(await t.store.getJob(job.id)).toMatchObject({ state: 'completed', lease: null });
  });

  test('a completed job is not claimable and shows in the counts', async () => {
    const job = await claimOne(t);
    await t.store.complete(job.lease, null);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    expect(await t.store.counts('q')).toMatchObject({ completed: 1, active: 0, waiting: 0 });
  });

  test('writes the completion record the result is read from', async () => {
    const job = await claimOne(t);
    t.clock.advance(50);
    await t.store.complete(job.lease, 'done');
    const [record] = await t.fresh.sql<
      { queue: string; completed_at: string; result: Uint8Array }[]
    >`SELECT queue, completed_at, result FROM qcloud_completions WHERE job_id = ${job.id}`;
    expect(record).toMatchObject({ queue: 'q', completed_at: String(START + 50) });
    expect(codec.decode(record!.result)).toBe('done');
  });

  test('an undefined result is stored as null', async () => {
    const job = await claimOne(t);
    expect(await t.store.complete(job.lease, undefined)).toMatchObject({ ok: true });
    expect(codec.decode((await readJob(t, job.id))!.result!)).toBeNull();
  });

  test('removeOnComplete deletes the job but keeps the completion record', async () => {
    const job = await claimOne(t, { removeOnComplete: true });
    expect(await t.store.complete(job.lease, 7)).toMatchObject({ ok: true });
    expect(await readJob(t, job.id)).toBeUndefined();
    expect(await t.store.getJob(job.id)).toBeNull();
    const [record] = await t.fresh.sql<{ result: Uint8Array }[]>`
      SELECT result FROM qcloud_completions WHERE job_id = ${job.id}`;
    expect(codec.decode(record!.result)).toBe(7);
    expect(log.events).toContainEqual({
      type: 'completed',
      queue: 'q',
      jobId: job.id,
      state: 'completed',
      removed: true,
    });
  });

  test('removeOnComplete also removes the job logs', async () => {
    const job = await claimOne(t, { removeOnComplete: true });
    await t.fresh.sql`
      INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
      VALUES ('test', ${job.id}, ${START}, 'info', 'hello')`;
    await t.store.complete(job.lease, null);
    const logs = await t.fresh.sql`SELECT 1 FROM qcloud_job_logs WHERE job_id = ${job.id}`;
    expect(logs).toHaveLength(0);
  });

  test('journals one completed event', async () => {
    const job = await claimOne(t);
    log.events.length = 0;
    await t.store.complete(job.lease, 1);
    expect(log.events).toEqual([
      { type: 'completed', queue: 'q', jobId: job.id, state: 'completed' },
    ]);
  });

  test('counts a completed metric in the minute bucket and the lifetime total', async () => {
    const [a, b] = await enqueueN(t.store, 2);
    const claimed = await t.another({ leaseMs: 120_000 }).claim('q', 'w', 2);
    expect(claimed.map((job) => job.id).sort()).toEqual([a!, b!].sort());
    await t.store.complete(claimed[0]!.lease, null);
    t.clock.advance(61_000);
    await t.store.complete(claimed[1]!.lease, null);
    const { total, buckets } = await metric(t, 'q', 'completed');
    expect(total).toBe(2);
    expect(buckets).toEqual([
      { minute: Math.floor(START / 60_000), count: 1 },
      { minute: Math.floor((START + 61_000) / 60_000), count: 1 },
    ]);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
  });

  test('the job the lease names is the only one touched', async () => {
    const [first, second] = await enqueueN(t.store, 2);
    const claimed = await t.store.claim('q', 'w', 2);
    const one = claimed.find((job) => job.id === first)!;
    await t.store.complete(one.lease, 'x');
    expect((await readJob(t, second!))!.state).toBe('active');
  });
});

describeDb('complete: a lease that no longer holds', () => {
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

  const unchanged = async (id: string, before: unknown) =>
    expect(await readJob(t, id)).toEqual(before as never);

  test('a stale token is refused and changes nothing', async () => {
    const job = await claimOne(t);
    const before = await readJob(t, job.id);
    const outcome = await t.store.complete({ ...job.lease, token: 'not-the-token' }, 'x');
    expect(outcome).toEqual({ ok: false, rings: [] });
    await unchanged(job.id, before);
    expect((await metric(t, 'q', 'completed')).total).toBe(0);
  });

  test('a malformed lease is refused without touching the database', async () => {
    const job = await claimOne(t);
    const before = await readJob(t, job.id);
    for (const lease of [
      { jobId: '', token: 'x', owner: 'w' },
      { jobId: job.id, token: '', owner: 'w' },
      null,
      undefined,
    ]) {
      expect(await t.store.complete(lease as never, 1)).toEqual({ ok: false, rings: [] });
    }
    await unchanged(job.id, before);
  });

  test('an unknown job is refused', async () => {
    const job = await claimOne(t);
    expect(await t.store.complete({ ...job.lease, jobId: 'no-such-job' }, 1)).toMatchObject({
      ok: false,
    });
  });

  test('completing twice: the second call is refused and the result stays the first', async () => {
    const job = await claimOne(t);
    expect(await t.store.complete(job.lease, 'first')).toMatchObject({ ok: true });
    const after = await readJob(t, job.id);
    expect(await t.store.complete(job.lease, 'second')).toEqual({ ok: false, rings: [] });
    await unchanged(job.id, after);
    expect(codec.decode(after!.result!)).toBe('first');
    expect((await metric(t, 'q', 'completed')).total).toBe(1);
  });

  test('a lease whose time has passed is refused, even before anything recovered the job', async () => {
    const job = await claimOne(t);
    expireLease(t, job);
    expect(await t.store.complete(job.lease, 1)).toEqual({ ok: false, rings: [] });
    expect((await readJob(t, job.id))!.state).toBe('active');
  });

  test('the instant before the lease expires still completes', async () => {
    const job = await claimOne(t);
    expireLease(t, job, -1);
    expect(await t.store.complete(job.lease, 1)).toMatchObject({ ok: true });
  });

  test('after recovery moved the job on, the old lease cannot complete it', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    const recovered = await readJob(t, job.id);
    expect(await t.store.complete(job.lease, 'late')).toEqual({ ok: false, rings: [] });
    await unchanged(job.id, recovered);
  });

  test('after a re-claim the old lease cannot complete the job; the new one can', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    const [again] = await t.store.claim('q', 'w2', 1);
    expect(again!.id).toBe(job.id);
    expect(await t.store.complete(job.lease, 'old')).toMatchObject({ ok: false });
    expect(await t.store.complete(again!.lease, 'new')).toMatchObject({ ok: true });
    expect(codec.decode((await readJob(t, job.id))!.result!)).toBe('new');
  });

  test('a released job cannot be completed with the old lease', async () => {
    const job = await claimOne(t);
    await t.store.release(job.lease);
    expect(await t.store.complete(job.lease, 1)).toMatchObject({ ok: false });
  });
});

describeDb('complete: results the store cannot keep', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ maxPayloadBytes: 1_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('a result over the size limit is a StoreError and the job stays active', async () => {
    const job = await claimOne(t);
    await expect(t.store.complete(job.lease, 'x'.repeat(2_000))).rejects.toBeInstanceOf(StoreError);
    expect((await readJob(t, job.id))!.state).toBe('active');
    expect(await t.store.complete(job.lease, 'small')).toMatchObject({ ok: true });
  });

  test('a result the codec cannot encode is a StoreError and the job stays active', async () => {
    const job = await claimOne(t);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(t.store.complete(job.lease, circular)).rejects.toBeInstanceOf(StoreError);
    expect((await readJob(t, job.id))!.state).toBe('active');
  });
});
