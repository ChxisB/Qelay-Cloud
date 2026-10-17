import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Ring } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TerminalChange } from '../src/store/context';
import { blobOf, claimOne, metric, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

describeDb('fail: the last attempt', () => {
  const log = recording();
  const changes: TerminalChange[] = [];
  let hookRings: Ring[] = [];
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({
      recorder: log.recorder,
      leaseMs: 30_000,
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
    log.failWith(null);
    changes.length = 0;
    hookRings = [];
  });

  test('moves the job to the DLQ: failed, with the error, the reason and the entry written once', async () => {
    const job = await claimOne(t, { attempts: 1 });
    t.clock.advance(2_000);
    const outcome = await t.store.fail(job.lease, {
      message: 'it broke',
      stack: 'Error: it broke\n    at handler',
      unrecoverable: false,
    });
    expect(outcome).toEqual({ ok: true, rings: [] });
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({
      state: 'failed',
      attempts: 1,
      completed_at: String(START + 2_000),
      rung_at: null,
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      error: 'it broke',
      failure_reason: 'max_attempts_exceeded',
      dlq_retry_state: null,
    });
    expect(blobOf(row)).toEqual({
      v: 1,
      enteredAt: START + 2_000,
      reason: 'max_attempts_exceeded',
      error: 'it broke',
      stack: 'Error: it broke\n    at handler',
      attempts: [
        {
          attempt: 1,
          startedAt: START,
          failedAt: START + 2_000,
          reason: 'max_attempts_exceeded',
          error: 'it broke',
          durationMs: 2_000,
        },
      ],
    });
  });

  test('is listed in the DLQ and is not claimable', async () => {
    const job = await claimOne(t, { attempts: 1 });
    await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    expect(await t.store.listDlq('q')).toEqual([
      { jobId: job.id, queue: 'q', attempts: 1, failedAt: START, reason: 'max_attempts_exceeded' },
    ]);
    expect(await t.store.claim('q', 'w', 5)).toEqual([]);
    expect(await t.store.counts('q')).toMatchObject({ failed: 1, active: 0 });
  });

  test('the history of earlier failures comes with the entry', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    let lease = job.lease;
    for (const message of ['one', 'two']) {
      await t.store.fail(lease, { message, unrecoverable: false });
      lease = (await t.store.claim('q', 'w', 1))[0]!.lease;
    }
    await t.store.fail(lease, { message: 'three', unrecoverable: false });
    const row = await readJob(t, job.id);
    expect(row!.attempts).toBe(3);
    expect(
      blobOf(row).attempts.map((record) => [record.attempt, record.error, record.reason])
    ).toEqual([
      [1, 'one', 'explicit_fail'],
      [2, 'two', 'explicit_fail'],
      [3, 'three', 'max_attempts_exceeded'],
    ]);
  });

  test('an unrecoverable failure skips the attempts left and records explicit_fail', async () => {
    const job = await claimOne(t, { attempts: 5 });
    await t.store.fail(job.lease, { message: 'bad input', unrecoverable: true });
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({ state: 'failed', attempts: 1, failure_reason: 'explicit_fail' });
    expect(blobOf(row).reason).toBe('explicit_fail');
  });

  test('removeOnFail deletes the job and leaves no DLQ entry', async () => {
    const job = await claimOne(t, { attempts: 1, removeOnFail: true });
    log.events.length = 0;
    expect(await t.store.fail(job.lease, { message: 'x', unrecoverable: false })).toMatchObject({
      ok: true,
    });
    expect(await readJob(t, job.id)).toBeUndefined();
    expect(await t.store.listDlq('q')).toEqual([]);
    expect(log.events).toEqual([
      { type: 'failed', queue: 'q', jobId: job.id, state: 'failed', error: 'x', removed: true },
    ]);
    expect((await metric(t, 'q', 'failed')).total).toBe(1);
  });

  test('removeOnFail does not apply to a failure that will be retried', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0, removeOnFail: true });
    await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    expect((await readJob(t, job.id))!.state).toBe('waiting');
  });

  test('journals one failed event, and counts one failed metric', async () => {
    const job = await claimOne(t, { attempts: 1 });
    log.events.length = 0;
    await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    expect(log.events).toEqual([
      { type: 'failed', queue: 'q', jobId: job.id, state: 'failed', error: 'x' },
    ]);
    const failed = await metric(t, 'q', 'failed');
    expect(failed.total).toBe(1);
    expect(failed.buckets).toEqual([{ minute: Math.floor(START / 60_000), count: 1 }]);
    expect((await metric(t, 'q', 'completed')).total).toBe(0);
  });

  test('runs the terminal hook for the failure and returns its rings', async () => {
    const job = await claimOne(t, { attempts: 1 });
    hookRings = [{ bell: { namespace: 'test', queue: 'q', jobId: 'parent' }, dueInMs: 0 }];
    const outcome = await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    expect(outcome.rings).toEqual(hookRings);
    expect(changes).toEqual([
      { jobId: job.id, queue: 'q', parentId: null, outcome: 'failed', error: 'x' },
    ]);
  });

  test('does not run the hook for a retry', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0 });
    await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    expect(changes).toEqual([]);
  });

  test('a journal failure rolls the whole failure back, and the same lease can fail again', async () => {
    const job = await claimOne(t, { attempts: 1 });
    const before = await readJob(t, job.id);
    log.failWith(new Error('journal is down'));
    await expect(t.store.fail(job.lease, { message: 'x', unrecoverable: false })).rejects.toThrow(
      'journal is down'
    );
    expect(await readJob(t, job.id)).toEqual(before!);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
    log.failWith(null);
    expect(await t.store.fail(job.lease, { message: 'x', unrecoverable: false })).toMatchObject({
      ok: true,
    });
  });
});

describeDb('fail: what a handler throws', () => {
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

  async function failWith(message: unknown, stack?: unknown) {
    const job = await claimOne(t, { attempts: 1 });
    const outcome = await t.store.fail(job.lease, {
      message,
      stack,
      unrecoverable: false,
    } as never);
    return { outcome, row: (await readJob(t, job.id))! };
  }

  test('NUL and lone surrogates, which the database refuses, are replaced', async () => {
    const { outcome, row } = await failWith('a\0b\uD800c\uDC00d', 'x\0y');
    expect(outcome.ok).toBe(true);
    expect(row.error).toBe('a�b�c�d');
    expect(blobOf(row).stack).toBe('x�y');
  });

  test('a well-formed surrogate pair is kept', async () => {
    expect((await failWith('smile \u{1F600}')).row.error).toBe('smile \u{1F600}');
  });

  test('a long message and stack are cut', async () => {
    const { row } = await failWith('m'.repeat(50_000), 's'.repeat(80_000));
    expect(row.error).toHaveLength(10_000);
    expect(blobOf(row).stack).toHaveLength(20_000);
  });

  test('a message that is not a string is the empty string, and the failure still counts', async () => {
    for (const odd of [undefined, null, 42, { nested: true }]) {
      await resetTables(t);
      const { outcome, row } = await failWith(odd);
      expect(outcome.ok).toBe(true);
      expect(row).toMatchObject({ state: 'failed', error: '' });
    }
  });

  test('a stack that is not a string is left out', async () => {
    const { row } = await failWith('x', 42);
    expect('stack' in blobOf(row)).toBe(false);
  });

  test('an empty message is kept as the empty string', async () => {
    const { row } = await failWith('');
    expect(row).toMatchObject({ state: 'failed', error: '' });
  });
});
