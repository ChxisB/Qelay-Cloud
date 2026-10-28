import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { addTree, failFor, fanOut } from '../../store-postgres/test/flowHelpers';
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

  /** The version of a DLQ entry, as the panel reads it and sends it back. */
  const versionOf = async (id: string): Promise<number> => {
    const { entries } = (await api.call('GET', '/queues/q/dlq')).body;
    return entries.find((entry: { job: { id: string } }) => entry.job.id === id).job.version;
  };

  test('retrying one entry puts the job back as waiting, takes it off the DLQ and audits the route and id', async () => {
    const [id] = await failJobs(1);
    const answer = await api.call('POST', `/queues/q/dlq/${id}/retry`, {
      expectedVersion: await versionOf(id!),
    });
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(0);
    expect((await api.call('GET', `/jobs/${id}`)).body.job).toMatchObject({
      state: 'waiting',
      attempts: 0,
    });
    const [entry] = (await f.store.audit.list({ limit: 1 })).items;
    expect(entry).toMatchObject({
      action: 'POST /queues/:queue/dlq/:jobId/retry',
      outcome: 'success',
      status: 200,
    });
    expect(entry!.target).toContain(id!);
    expect(JSON.stringify(entry)).not.toContain('boom');
  });

  test('a retry the job does not take is 4xx, names why and changes nothing', async () => {
    const [id] = await failJobs(1);
    const [waiting] = await enqueueN(f.store, 1, {}, 'q');
    const version = await versionOf(id!);
    const refused = async (job: string, body?: object) => {
      const answer = await api.call('POST', `/queues/q/dlq/${job}/retry`, body);
      return [answer.status, answer.body.error.code];
    };
    expect(await refused('nope')).toEqual([404, 'job_not_found']);
    expect(await refused(id!, { expectedVersion: version + 1 })).toEqual([409, 'version_conflict']);
    expect(await refused(waiting!)).toEqual([409, 'job_state']);
    expect(await refused(id!, { expected: version })).toEqual([400, 'invalid_request']);
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
    // The first caller wins; the second finds a waiting job, not a failed one.
    expect((await api.call('POST', `/queues/q/dlq/${id}/retry`)).status).toBe(200);
    expect(await refused(id!)).toEqual([409, 'job_state']);
  });

  test('a flow member and a job whose dedup key is taken are 409 and stay in the DLQ', async () => {
    await addTree(f.store, fanOut(1));
    const child = await failFor(f.t, 'children');
    const flow = await api.call('POST', `/queues/children/dlq/${child.id}/retry`);
    expect(flow).toMatchObject({ status: 409, body: { error: { code: 'flow_member' } } });

    const dedup = { deduplication: { id: 'k' } };
    const job = await claimOne(f.t, { attempts: 1, ...dedup }, 'q', 'w');
    await f.store.fail(job.lease, { message: 'boom', unrecoverable: true });
    await f.store.enqueue([{ queue: 'q', data: 2, options: dedup }]);
    const taken = await api.call('POST', `/queues/q/dlq/${job.id}/retry`);
    expect(taken).toMatchObject({ status: 409, body: { error: { code: 'duplicate_job' } } });
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
  });

  test('retrying a set needs the queue name, stops at the limit, says what is left and takes a reason', async () => {
    const ids = await failJobs(3);
    for (const body of [undefined, {}, { confirm: 'other' }]) {
      const answer = await api.call('POST', '/queues/q/dlq/retry', body);
      expect(answer.body.error.code).toBe('confirmation_required');
    }
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(3);

    const first = await api.call('POST', '/queues/q/dlq/retry', { confirm: 'q', limit: 2 });
    expect(first.body).toEqual({ ok: true, count: 2, remaining: 1, done: false });
    const left = (await api.call('GET', '/queues/q/dlq')).body.entries;
    expect(left.map((entry: { job: { id: string } }) => entry.job.id)).toEqual([ids[2]]);

    const none = await api.call('POST', '/queues/q/dlq/retry', { confirm: 'q', reason: 'timeout' });
    expect(none.body).toEqual({ ok: true, count: 0, remaining: 0, done: true });
    const rest = await api.call('POST', '/queues/q/dlq/retry', { confirm: 'q' });
    expect(rest.body).toEqual({ ok: true, count: 1, remaining: 0, done: true });
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(3);
    const [entry] = (await f.store.audit.list({ limit: 1 })).items;
    expect(entry).toMatchObject({ action: 'POST /queues/:queue/dlq/retry', status: 200 });
  });

  test('a set is limited to 1 to 500 and to the four reasons, and only that queue is retried', async () => {
    await failJobs(1, 'other');
    for (const body of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { reason: 'because' }]) {
      const answer = await api.call('POST', '/queues/q/dlq/retry', { confirm: 'q', ...body });
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    const none = await api.call('POST', '/queues/q/dlq/retry', { confirm: 'q', limit: 500 });
    expect(none.body).toEqual({ ok: true, count: 0, remaining: 0, done: true });
    expect((await api.call('GET', '/queues/other/dlq')).body.total).toBe(1);
  });

  test('the capabilities no longer list retry or retention as closed, and still list auto-retry', async () => {
    const { unsupported } = (await api.call('GET', '/capabilities')).body;
    expect(unsupported).not.toContain('dlq-retry');
    expect(unsupported).not.toContain('dlq-retention');
    expect(unsupported).toContain('dlq-auto-retry');
  });

  test('a viewer reads the DLQ and cannot purge or retry', async () => {
    await failJobs(1);
    expect((await api.asViewer('GET', '/queues/q/dlq')).status).toBe(200);
    expect((await api.asViewer('GET', '/queues/q/dlq/stats')).status).toBe(200);
    const [id] = (await api.call('GET', '/queues/q/dlq')).body.entries.map(
      (entry: { job: { id: string } }) => entry.job.id
    );
    for (const path of [
      '/queues/q/dlq/purge',
      '/queues/q/dlq/retry',
      `/queues/q/dlq/${id}/retry`,
    ]) {
      const answer = await api.asViewer('POST', path, { confirm: 'q' });
      expect(answer.status, path).toBe(403);
    }
    expect((await api.call('GET', '/queues/q/dlq')).body.total).toBe(1);
  });
});
