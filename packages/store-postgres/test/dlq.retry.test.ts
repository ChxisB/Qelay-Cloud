import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_DLQ_RETRY } from '../src';
import { blobOf, claimOne, readJob, recording, resetTables, retryStateOf } from './finishHelpers';
import { addTree, failFor, fanOut } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('dlq: retry', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  /** Fails one new job of the queue for good, one second after the last; returns its id. */
  async function fillDlq(queue = 'q', options = {}, unrecoverable = true): Promise<string> {
    t.clock.advance(1_000);
    const job = await claimOne(t, { attempts: 1, ...options }, queue);
    await t.store.fail(job.lease, { message: 'x', unrecoverable });
    return job.id;
  }

  test('a retried job is waiting again with no attempt used and no entry, a worker runs it, and a bell comes back', async () => {
    const id = await fillDlq();
    const before = await readJob(t, id);
    log.events.length = 0;
    t.clock.advance(5_000);
    const result = await t.store.retryDlq('q', id);
    if (!result.ok) throw new Error(`refused as ${result.reason}`);
    expect(result.rings.map((ring) => [ring.bell.jobId, ring.dueInMs])).toEqual([[id, 0]]);
    const row = await readJob(t, id);
    expect(row).toMatchObject({
      state: 'waiting',
      attempts: 0,
      error: null,
      failure_reason: null,
      dlq_entry: null,
      completed_at: null,
      started_at: null,
    });
    expect(Number(row!.version)).toBe(Number(before!.version) + 1);
    expect(Number(row!.run_at)).toBe(t.clock.now());
    expect(await t.store.listDlq('q')).toEqual([]);
    expect(log.events).toEqual([{ type: 'retried', queue: 'q', jobId: id, state: 'waiting' }]);

    const [claimed] = await t.store.claim('q', 'w', 1);
    expect(claimed).toMatchObject({ id, attempts: 0 });
    expect((await t.store.complete(claimed!.lease, 'done')).ok).toBe(true);
    expect((await readJob(t, id))!.state).toBe('completed');
  });

  test('a prioritized job comes back prioritized, at its own priority', async () => {
    const id = await fillDlq('q', { priority: 3 });
    const result = await t.store.retryDlq('q', id);
    expect(result.ok).toBe(true);
    expect((await readJob(t, id))!.state).toBe('prioritized');
  });

  test('refusals change nothing: a missing job, one in another queue, one that is not failed', async () => {
    const id = await fillDlq();
    const waiting = (await t.store.enqueue([{ queue: 'q', data: 1 }]))[0]!.id;
    expect(await t.store.retryDlq('q', 'nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(await t.store.retryDlq('other', id)).toEqual({ ok: false, reason: 'not_found' });
    expect(await t.store.retryDlq('q', waiting)).toEqual({ ok: false, reason: 'not_failed' });
    expect((await readJob(t, id))!.state).toBe('failed');
    expect((await readJob(t, waiting))!.state).toBe('waiting');
  });

  test('a stale expectedVersion is refused before anything else, and the right one retries', async () => {
    const id = await fillDlq();
    const version = Number((await readJob(t, id))!.version);
    expect(await t.store.retryDlq('q', id, { expectedVersion: version - 1 })).toEqual({
      ok: false,
      reason: 'version',
    });
    expect((await readJob(t, id))!.state).toBe('failed');
    expect((await t.store.retryDlq('q', id, { expectedVersion: version })).ok).toBe(true);
    // The version moved with the retry, so asking again with the old one is stale, not "not failed".
    expect(await t.store.retryDlq('q', id, { expectedVersion: version })).toEqual({
      ok: false,
      reason: 'version',
    });
  });

  test('a double retry retries once and the second answers not_failed', async () => {
    const id = await fillDlq();
    const [a, b] = await Promise.all([t.store.retryDlq('q', id), t.another().retryDlq('q', id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const refused = [a, b].find((result) => !result.ok)!;
    expect(refused).toEqual({ ok: false, reason: 'not_failed' });
    expect(log.events.filter((event) => event.type === 'retried')).toHaveLength(1);
  });

  test('retry racing purge: exactly one of them wins', async () => {
    for (let round = 0; round < 10; round++) {
      const id = await fillDlq();
      const other = t.another();
      const [retried, purged] = await Promise.all([
        t.store.retryDlq('q', id),
        other.purgeDlq('q', [id]),
      ]);
      const row = await readJob(t, id);
      if (retried.ok) {
        // The retry took the row first: the purge found nothing failed to delete.
        expect(purged).toBe(0);
        expect(row!.state).toBe('waiting');
      } else {
        expect(retried.reason === 'not_found' || retried.reason === 'not_failed').toBe(true);
        expect(purged).toBe(1);
        expect(row).toBeUndefined();
      }
      await t.fresh.sql`DELETE FROM qcloud_jobs`;
    }
  });

  test('a flow member is refused, whether it is a child or a parent', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    const failed = await failFor(t, 'children');
    expect(failed.id).toBe(child!.id);
    expect(await t.store.retryDlq('children', child!.id)).toEqual({
      ok: false,
      reason: 'flow_member',
    });
    expect((await readJob(t, child!.id))!.state).toBe('failed');
    expect(parent).toBeDefined();
  });

  test('a job whose dedup key a live job holds is refused as duplicate, and is retryable once that job ends', async () => {
    const dedup = { deduplication: { id: 'k' } };
    const old = await fillDlq('q', dedup);
    const [live] = await t.store.enqueue([{ queue: 'q', data: 2, options: dedup }]);
    expect(live!.created).toBe(true);
    expect(await t.store.retryDlq('q', old)).toEqual({ ok: false, reason: 'duplicate' });
    expect((await readJob(t, old))!.state).toBe('failed');

    const [claimed] = await t.store.claim('q', 'w', 1);
    await t.store.complete(claimed!.lease, 'ok');
    expect((await t.store.retryDlq('q', old)).ok).toBe(true);
  });

  test('retryDlqMany stops at the limit, oldest failure first, and reports what is left', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await fillDlq());
    log.events.length = 0;
    const result = await t.store.retryDlqMany('q', { limit: 3 });
    expect(result.retried).toEqual(ids.slice(0, 3));
    expect(result.remaining).toBe(2);
    expect(result.rings.map((ring) => ring.bell.jobId)).toEqual(ids.slice(0, 3));
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual(ids.slice(3));
    expect(log.events.filter((event) => event.type === 'retried')).toHaveLength(3);

    const rest = await t.store.retryDlqMany('q', { limit: 3 });
    expect(rest).toMatchObject({ retried: ids.slice(3), remaining: 0 });
    expect(await t.store.retryDlqMany('q', { limit: 3 })).toMatchObject({
      retried: [],
      remaining: 0,
      rings: [],
    });
  });

  test('retryDlqMany by reason takes only that reason and leaves the others', async () => {
    const explicit = await fillDlq('q', {}, true);
    const exhausted = await fillDlq('q', {}, false);
    const result = await t.store.retryDlqMany('q', { limit: 10, reason: 'explicit_fail' });
    expect(result).toMatchObject({ retried: [explicit], remaining: 0 });
    expect((await readJob(t, exhausted))!.state).toBe('failed');
  });

  test('retryDlqMany leaves flow members and duplicates alone and does not count them as remaining', async () => {
    await addTree(t.store, fanOut(1));
    await failFor(t, 'children');
    const dedup = { deduplication: { id: 'k' } };
    await fillDlq('q', dedup);
    const plain = await fillDlq('q');
    await t.store.enqueue([{ queue: 'q', data: 2, options: dedup }]);
    expect(await t.store.retryDlqMany('children', { limit: 10 })).toMatchObject({
      retried: [],
      remaining: 0,
    });
    expect(await t.store.retryDlqMany('q', { limit: 10 })).toMatchObject({
      retried: [plain],
      remaining: 0,
    });
  });

  test('two failed jobs that share a dedup key do not both go back: the oldest does, the other is a duplicate', async () => {
    const dedup = { deduplication: { id: 'k' } };
    const first = await fillDlq('q', dedup);
    const second = await fillDlq('q', dedup);
    const result = await t.store.retryDlqMany('q', { limit: 10 });
    expect(result).toMatchObject({ retried: [first], remaining: 0 });
    expect(await t.store.retryDlq('q', second)).toEqual({ ok: false, reason: 'duplicate' });
    expect((await readJob(t, second))!.state).toBe('failed');
  });

  test('retryDlqMany checks its limit and reason', async () => {
    for (const limit of [0, -1, 1.5, MAX_DLQ_RETRY + 1, Number.NaN]) {
      await expect(t.store.retryDlqMany('q', { limit })).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
    }
    await expect(t.store.retryDlqMany('q', { limit: 1, reason: 'because' })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(t.store.retryDlqMany('q', { limit: MAX_DLQ_RETRY })).resolves.toBeDefined();
  });

  test('the history of the failed attempts is kept on the retried job', async () => {
    t.clock.advance(1_000);
    const job = await claimOne(t, { attempts: 1 }, 'q');
    await t.store.fail(job.lease, { message: 'first', unrecoverable: true });
    const entry = blobOf(await readJob(t, job.id));
    expect(entry.attempts.length).toBeGreaterThan(0);
    await t.store.retryDlq('q', job.id);
    expect(retryStateOf(await readJob(t, job.id)).attempts).toEqual(entry.attempts);
    const [again] = await t.store.claim('q', 'w', 1);
    await t.store.fail(again!.lease, { message: 'second', unrecoverable: true });
    const second = blobOf(await readJob(t, job.id));
    expect(second.attempts.map((attempt) => attempt.error)).toEqual(['first', 'second']);
  });
});
