import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('queues action routes', () => {
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

  const counts = async (queue = 'q') =>
    (await api.call('GET', `/queues/${queue}/counts`)).body.counts;

  /** Two completed, one failed, one active, two waiting and one delayed, in that order of creation. */
  async function populate(): Promise<void> {
    for (let index = 0; index < 2; index += 1) {
      const job = await claimOne(f.t, {}, 'q', 'w');
      await f.store.complete(job.lease, index);
    }
    const bad = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
    await f.store.fail(bad.lease, { message: 'boom', unrecoverable: true });
    await claimOne(f.t, {}, 'q', 'w');
    await enqueueN(f.store, 2, {}, 'q');
    await enqueueN(f.store, 1, { delay: 60_000 }, 'q');
  }

  test('queues pause holds claims back and resume lets them go', async () => {
    await enqueueN(f.store, 2, {}, 'q');
    expect((await api.call('POST', '/queues/q/pause')).body).toEqual({ ok: true });
    expect(await f.store.claim('q', 'w', 2)).toEqual([]);
    expect((await api.call('GET', '/queues/q/paused')).body.paused).toBe(true);
    expect((await api.call('POST', '/queues/q/resume')).body).toEqual({ ok: true });
    expect(await f.store.claim('q', 'w', 2)).toHaveLength(2);
  });

  test('queues drain, clean and obliterate are refused without the queue name as confirm', async () => {
    await populate();
    const before = await counts();
    for (const action of ['drain', 'clean', 'obliterate']) {
      const none = await api.call('POST', `/queues/q/${action}`);
      expect(none.status, action).toBe(400);
      expect(none.body.error.code, action).toBe('confirmation_required');
      const wrong = await api.call('POST', `/queues/q/${action}`, { confirm: 'other' });
      expect(wrong.status, action).toBe(400);
      expect(wrong.body.error.code, action).toBe('confirmation_required');
    }
    expect(await counts()).toEqual(before);
  });

  test('queues drain deletes what has not run and leaves active and finished jobs', async () => {
    await populate();
    const answer = await api.call('POST', '/queues/q/drain', { confirm: 'q' });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, count: 3, done: true } });
    expect(await counts()).toMatchObject({
      waiting: 0,
      delayed: 0,
      prioritized: 0,
      active: 1,
      completed: 2,
      failed: 1,
    });
  });

  test('queues clean removes completed jobs older than the grace, and failed ones on request', async () => {
    await populate();
    const early = await api.call('POST', '/queues/q/clean', { confirm: 'q', grace: 60_000 });
    expect(early.body).toMatchObject({ count: 0, done: true });
    f.t.clock.advance(60_001);
    const completed = await api.call('POST', '/queues/q/clean', { confirm: 'q', grace: 60_000 });
    expect(completed.body).toMatchObject({ ok: true, count: 2, done: true });
    expect(await counts()).toMatchObject({ completed: 0, failed: 1 });
    const failed = await api.call('POST', '/queues/q/clean', { confirm: 'q', state: 'failed' });
    expect(failed.body.count).toBe(1);
    // The delayed job came due while the clock moved, so it counts as waiting now.
    expect(await counts()).toMatchObject({ failed: 0, waiting: 3, delayed: 0, active: 1 });
  });

  test('queues clean takes a limit and the pending states, with wait as waiting', async () => {
    await populate();
    const limited = await api.call('POST', '/queues/q/clean', { confirm: 'q', limit: 1 });
    expect(limited.body).toMatchObject({ count: 1, done: true });
    expect(await counts()).toMatchObject({ completed: 1 });
    const waiting = await api.call('POST', '/queues/q/clean', { confirm: 'q', state: 'wait' });
    expect(waiting.body.count).toBe(2);
    const delayed = await api.call('POST', '/queues/q/clean', { confirm: 'q', state: 'delayed' });
    expect(delayed.body.count).toBe(1);
    expect(await counts()).toMatchObject({ waiting: 0, delayed: 0, active: 1 });
  });

  test('queues clean refuses a state it does not know and a misspelt field', async () => {
    const state = await api.call('POST', '/queues/q/clean', { confirm: 'q', state: 'active' });
    expect(state.status).toBe(400);
    const field = await api.call('POST', '/queues/q/clean', { confirm: 'q', gracePeriod: 5 });
    expect(field.status).toBe(400);
  });

  test('queues obliterate with an active job is 409 until it is forced', async () => {
    await populate();
    const refused = await api.call('POST', '/queues/q/obliterate', { confirm: 'q' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('job_state');
    expect(await counts()).toMatchObject({ active: 1, completed: 2 });
    const forced = await api.call('POST', '/queues/q/obliterate', { confirm: 'q', force: true });
    expect(forced.body).toMatchObject({ ok: true, done: true });
    expect(forced.body.count).toBeGreaterThanOrEqual(7);
    expect(await counts()).toMatchObject({ waiting: 0, active: 0, completed: 0, failed: 0 });
    const summary = await api.call<{ name: string }[]>('GET', '/queues/summary');
    expect(summary.body.find((queue) => queue.name === 'q')).toBeUndefined();
  });

  test('queues obliterate of a queue without an active job needs no force', async () => {
    await enqueueN(f.store, 3, {}, 'q');
    const answer = await api.call('POST', '/queues/q/obliterate', { confirm: 'q' });
    expect(answer.body).toMatchObject({ ok: true, done: true });
    expect(await counts()).toMatchObject({ waiting: 0 });
  });

  test('queues rate limit is set, read back by the store and lifted', async () => {
    const set = await api.call('PUT', '/queues/q/rate-limit', { limit: 10, duration: 2_000 });
    expect(set.body).toEqual({ ok: true });
    expect((await f.store.queues.config('q')).rateLimit).toMatchObject({
      max: 10,
      durationMs: 2_000,
    });
    expect((await api.call('DELETE', '/queues/q/rate-limit')).body).toEqual({ ok: true });
    expect((await f.store.queues.config('q')).rateLimit).toBeNull();
  });

  test('queues rate limit and concurrency refuse values that are not positive integers', async () => {
    for (const body of [{ limit: 0 }, { limit: 1.5 }, { limit: -1 }, {}, { limit: 5, extra: 1 }]) {
      expect((await api.call('PUT', '/queues/q/rate-limit', body)).status).toBe(400);
    }
    for (const body of [{ concurrency: 0 }, { concurrency: 'two' }, {}]) {
      expect((await api.call('PUT', '/queues/q/concurrency', body)).status).toBe(400);
    }
    expect((await f.store.queues.config('q')).rateLimit).toBeNull();
  });

  test('queues concurrency is set and lifted', async () => {
    expect((await api.call('PUT', '/queues/q/concurrency', { concurrency: 3 })).body).toEqual({
      ok: true,
    });
    expect((await f.store.queues.config('q')).concurrencyLimit).toBe(3);
    await api.call('DELETE', '/queues/q/concurrency');
    expect((await f.store.queues.config('q')).concurrencyLimit).toBeNull();
  });

  test('queues promote-jobs makes delayed jobs due and rings their bells', async () => {
    await enqueueN(f.store, 3, { delay: 600_000 }, 'q');
    const answer = await api.call('POST', '/queues/q/promote-jobs', { count: 2 });
    expect(answer.body).toMatchObject({ ok: true, count: 2, done: false });
    expect(await counts()).toMatchObject({ waiting: 2, delayed: 1 });
    expect(f.transport.buffered('q').ready).toBe(2);
    const rest = await api.call('POST', '/queues/q/promote-jobs');
    expect(rest.body).toMatchObject({ count: 1, done: true });
  });

  test('queues actions need an operator and a viewer changes nothing', async () => {
    await populate();
    const before = await counts();
    const attempts: [string, string, unknown?][] = [
      ['POST', '/queues/q/pause'],
      ['POST', '/queues/q/resume'],
      ['POST', '/queues/q/drain', { confirm: 'q' }],
      ['POST', '/queues/q/clean', { confirm: 'q' }],
      ['POST', '/queues/q/obliterate', { confirm: 'q', force: true }],
      ['POST', '/queues/q/promote-jobs'],
      ['PUT', '/queues/q/rate-limit', { limit: 1 }],
      ['DELETE', '/queues/q/rate-limit'],
      ['PUT', '/queues/q/concurrency', { concurrency: 1 }],
      ['DELETE', '/queues/q/concurrency'],
    ];
    for (const [method, path, body] of attempts) {
      expect((await api.asViewer(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(await counts()).toEqual(before);
    expect((await api.call('GET', '/queues/q/paused')).body.paused).toBe(false);
  });
});
