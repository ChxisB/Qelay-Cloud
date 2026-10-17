import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

/** One completed job, one failed, one active, three waiting, one prioritized and one delayed. */
async function seed(f: JobsFixture): Promise<void> {
  const done = await claimOne(f.t, {}, 'q', 'w1');
  await f.store.complete(done.lease, 'ok');
  const bad = await claimOne(f.t, { attempts: 1 }, 'q', 'w1');
  await f.store.fail(bad.lease, { message: 'boom', unrecoverable: true });
  await claimOne(f.t, {}, 'q', 'w2');
  await enqueueN(f.store, 3, {}, 'q');
  await enqueueN(f.store, 1, { priority: 3 }, 'q');
  await enqueueN(f.store, 1, { delay: 60_000 }, 'q');
}

describeDb('dashboard routes', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());

  test('dashboard totals come from the counters and the lifetime totals', async () => {
    await seed(f);
    const answer = await f.api().call('GET', '/dashboard');
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.stats).toMatchObject({
      waiting: 3,
      active: 1,
      delayed: 1,
      completed: 1,
      dlq: 1,
      totalCompleted: 1,
      totalFailed: 1,
      // Pulled: every job that was claimed. Pushed: those and everything still waiting to be.
      totalPulled: 3,
      totalPushed: 8,
    });
    expect(answer.body.storage).toMatchObject({ engine: 'postgres', diskFull: false });
    expect(answer.body.workers).toMatchObject({ total: 0, list: [], truncated: false });
    expect(answer.body.crons).toMatchObject({ total: 0, list: [], truncated: false });
    expect(answer.body.collections).toMatchObject({ queues: 1, pausedQueues: 0 });
    expect(answer.body.timestamp).toBe(f.t.clock.now());
  });

  test('dashboard rates are 0 on the first read and the change per second after', async () => {
    await seed(f);
    const { call } = f.api();
    const first = await call('GET', '/dashboard');
    expect(first.body.throughput).toEqual({
      pushPerSec: 0,
      pullPerSec: 0,
      completePerSec: 0,
      failPerSec: 0,
    });
    const next = await claimOne(f.t, {}, 'q', 'w3');
    await f.store.complete(next.lease, 'ok');
    f.t.clock.advance(10_000);
    const second = await call('GET', '/dashboard');
    expect(second.body.stats.totalCompleted).toBe(2);
    expect(second.body.throughput.completePerSec).toBeCloseTo(0.1, 5);
    expect(second.body.throughput.failPerSec).toBe(0);
    expect(second.body.stats.uptime).toBe(10);
  });

  test('dashboard stats adds prioritized and waiting-children, and keeps its own rate baseline', async () => {
    await seed(f);
    const { call } = f.api();
    await call('GET', '/dashboard');
    const first = await call('GET', '/stats');
    expect(first.body.stats).toMatchObject({
      prioritized: 1,
      'waiting-children': 0,
      waiting: 3,
      completePerSec: 0,
    });
    expect(first.body.memory.heapUsed).toBeNumber();
    expect(first.body.memory).toHaveProperty('external');
    expect(first.body.collections).toMatchObject({ queues: 1 });
  });

  test('dashboard answer is kept for the cache time and a bypass header reads fresh', async () => {
    const api = f.api({ summaryCacheMs: 2_000 });
    await enqueueN(f.store, 2, {}, 'q');
    const first = await api.call('GET', '/dashboard');
    expect(first.body.stats.waiting).toBe(2);
    await enqueueN(f.store, 3, {}, 'q');
    const kept = await api.call('GET', '/dashboard');
    expect(kept.body.stats.waiting).toBe(2);
    const fresh = await api.call('GET', '/dashboard', undefined, { 'x-qelay-cache': 'bypass' });
    expect(fresh.body.stats.waiting).toBe(5);
    // The bypass read replaces the kept one.
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(5);
  });

  test('dashboard answer is read again once the cache time has passed', async () => {
    const api = f.api({ summaryCacheMs: 2_000 });
    await enqueueN(f.store, 1, {}, 'q');
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(1);
    await enqueueN(f.store, 1, {}, 'q');
    f.t.clock.advance(1_999);
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(1);
    f.t.clock.advance(1);
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(2);
  });

  test('dashboard cache is per instance and also holds queues summary', async () => {
    const one = f.api({ summaryCacheMs: 2_000 });
    const two = f.api({ summaryCacheMs: 2_000 });
    await enqueueN(f.store, 1, {}, 'q');
    const before = await one.call<unknown[]>('GET', '/queues/summary');
    expect(before.body).toHaveLength(1);
    await enqueueN(f.store, 1, {}, 'other');
    expect((await one.call<unknown[]>('GET', '/queues/summary')).body).toHaveLength(1);
    expect((await two.call<unknown[]>('GET', '/queues/summary')).body).toHaveLength(2);
    const bypass = await one.call<unknown[]>('GET', '/queues/summary', undefined, {
      'x-qelay-cache': 'bypass',
    });
    expect(bypass.body).toHaveLength(2);
  });

  test('dashboard with the cache off reads every time', async () => {
    const api = f.api({ summaryCacheMs: 0 });
    await enqueueN(f.store, 1, {}, 'q');
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(1);
    await enqueueN(f.store, 1, {}, 'q');
    expect((await api.call('GET', '/dashboard')).body.stats.waiting).toBe(2);
  });

  test('dashboard routes need a token', async () => {
    const api = f.api();
    expect((await api.api.call('GET', '/dashboard', { token: null })).status).toBe(401);
    expect((await api.api.call('GET', '/stats', { token: null })).status).toBe(401);
  });
});
