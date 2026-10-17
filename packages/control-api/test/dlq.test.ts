import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('dead-letter queue routes', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
  });

  /** Fails `count` jobs of `queue` for good, so each is a DLQ entry. Returns their ids. */
  async function failJobs(count: number, queue = 'q', message = 'boom'): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const job = await claimOne(f.t, { attempts: 1 }, queue, 'w');
      await f.store.fail(job.lease, { message, unrecoverable: true });
      ids.push(job.id);
    }
    return ids;
  }

  test('lists the failed jobs with how each failed', async () => {
    const [first, second] = await failJobs(2);
    const answer = await api.call('GET', '/queues/q/dlq');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, total: 2, offset: 0 });
    const { maxAge } = (await api.call('GET', '/queues/q/dlq-config')).body.config;
    const entries = answer.body.entries as Array<Record<string, any>>;
    expect(entries.map((entry) => entry.job.id).sort()).toEqual([first!, second!].sort());
    for (const entry of entries) {
      expect(entry.job.state).toBe('failed');
      expect(entry.error).toBe('boom');
      expect(typeof entry.reason).toBe('string');
      expect(entry.attempts.length).toBeGreaterThan(0);
      expect(entry.expiresAt).toBe(entry.enteredAt + maxAge);
    }
  });

  test('an empty queue is an empty page and not an error', async () => {
    const answer = await api.call('GET', '/queues/nothing/dlq');
    expect(answer).toMatchObject({
      status: 200,
      body: { ok: true, entries: [], total: 0, offset: 0 },
    });
  });

  test('pages with limit and offset and reports the whole total', async () => {
    await failJobs(3);
    const page = await api.call('GET', '/queues/q/dlq?limit=2&offset=2');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page.body.entries).toHaveLength(1);
    const clamped = await api.call('GET', '/queues/q/dlq?limit=100000');
    expect(clamped.body.limit).toBeLessThanOrEqual(500);
  });

  test('refuses a limit that is not a number, and an offset past what a list walks', async () => {
    expect((await api.call('GET', '/queues/q/dlq?limit=x')).status).toBe(400);
    const far = await api.call('GET', '/queues/q/dlq?offset=1000000');
    expect(far.status).toBe(400);
    expect(far.body.error.code).toBe('offset_too_large');
  });

  test('a queue that keeps entries for ever has no expiry on them', async () => {
    await failJobs(1);
    await f.store.queues.setDlqConfig('q', { maxAge: null });
    const entry = (await api.call('GET', '/queues/q/dlq')).body.entries[0];
    expect(entry.expiresAt).toBeNull();
  });

  test('stats count by reason and carry the oldest and newest failure', async () => {
    await failJobs(2);
    const answer = await api.call('GET', '/queues/q/dlq/stats');
    expect(answer.status).toBe(200);
    const stats = answer.body.stats;
    expect(stats.total).toBe(2);
    expect(stats.byQueue).toEqual({ q: 2 });
    expect(Object.values(stats.byReason).reduce((sum: number, n) => sum + (n as number), 0)).toBe(
      2
    );
    expect(stats.pendingRetry).toBe(0);
    expect(stats.expired).toBe(0);
    expect(typeof stats.oldestEntry).toBe('number');
    expect(stats.newestEntry).toBeGreaterThanOrEqual(stats.oldestEntry);
  });

  test('stats of a queue without failures are zero with no dates', async () => {
    const stats = (await api.call('GET', '/queues/none/dlq/stats')).body.stats;
    expect(stats).toMatchObject({ total: 0, byReason: {}, oldestEntry: null, newestEntry: null });
  });

  test('purge is refused without the queue name as confirm and deletes nothing', async () => {
    await failJobs(2);
    for (const body of [undefined, {}, { confirm: 'other' }]) {
      const answer = await api.call('POST', '/queues/q/dlq/purge', body);
      expect(answer.status).toBe(400);
      expect(answer.body.error.code).toBe('confirmation_required');
    }
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(2);
  });

  test('purge deletes the entries of that queue only', async () => {
    await failJobs(3, 'q');
    await failJobs(1, 'other');
    await enqueueN(f.store, 1, {}, 'q');
    const answer = await api.call('POST', '/queues/q/dlq/purge', { confirm: 'q' });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, count: 3, done: true } });
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(0);
    expect((await api.call('GET', '/queues/other/dlq')).body.total).toBe(1);
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(1);
  });

  test('purging an empty queue answers zero and done', async () => {
    const answer = await api.call('POST', '/queues/q/dlq/purge', { confirm: 'q' });
    expect(answer.body).toEqual({ ok: true, count: 0, done: true });
  });

  test('purge stops at the time budget and says it is not done', async () => {
    await failJobs(2);
    const bounded = f.api({ summaryCacheMs: 0, actionBudgetMs: 1 });
    const store = f.store;
    const real = store.purgeDlq.bind(store);
    // One entry per call, and a clock that has moved past the budget after the first one.
    store.purgeDlq = async (queue, ids) => {
      const removed = await real(queue, ids?.slice(0, 1));
      f.t.clock.advance(5);
      return removed;
    };
    try {
      const answer = await bounded.call('POST', '/queues/q/dlq/purge', { confirm: 'q' });
      expect(answer.body).toEqual({ ok: true, count: 1, done: false });
    } finally {
      store.purgeDlq = real;
    }
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
  });

  test('retry is closed and the capabilities list says so', async () => {
    const [id] = await failJobs(1);
    const all = await api.call('POST', '/queues/q/dlq/retry');
    expect(all).toMatchObject({
      status: 501,
      body: { error: { code: 'not_supported', details: { capability: 'dlq-retry' } } },
    });
    const one = await api.call('POST', `/queues/q/dlq/${id}/retry`);
    expect(one.status).toBe(501);
    const capabilities = await api.call('GET', '/capabilities');
    expect(capabilities.body.unsupported).toContain('dlq-retry');
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
  });

  test('a viewer reads the DLQ and cannot purge or retry', async () => {
    await failJobs(1);
    expect((await api.asViewer('GET', '/queues/q/dlq')).status).toBe(200);
    expect((await api.asViewer('GET', '/queues/q/dlq/stats')).status).toBe(200);
    for (const path of ['/queues/q/dlq/purge', '/queues/q/dlq/retry']) {
      const answer = await api.asViewer('POST', path, { confirm: 'q' });
      expect(answer.status, path).toBe(403);
    }
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
  });
});
