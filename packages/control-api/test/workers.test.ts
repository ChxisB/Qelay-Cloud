import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('worker routes', () => {
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

  const register = (id: string, queues = ['q']) =>
    f.store.workers.register({
      id,
      queues,
      name: `name-${id}`,
      hostname: 'host-1',
      pid: 4242,
      concurrency: 3,
    });
  const list = async () => (await api.call('GET', '/workers')).body;

  test('an empty registry is an empty list with zero stats', async () => {
    expect(await list()).toEqual({
      ok: true,
      data: { workers: [], stats: { total: 0, active: 0, stale: 0 } },
    });
  });

  test('a registered worker is listed as the panel reads it', async () => {
    await register('w1', ['a', 'b']);
    f.t.clock.advance(5_000);
    await f.store.workers.heartbeat('w1', { activeJobs: 2, processed: 10, failed: 1 });
    f.t.clock.advance(1_000);
    const body = await list();
    expect(body.data.stats).toEqual({ total: 1, active: 1, stale: 0 });
    expect(body.data.workers[0]).toMatchObject({
      id: 'w1',
      name: 'name-w1',
      queues: ['a', 'b'],
      concurrency: 3,
      hostname: 'host-1',
      pid: 4242,
      status: 'active',
      activeJobs: 2,
      processedJobs: 10,
      failedJobs: 1,
      currentJob: null,
      uptime: 6_000,
    });
  });

  test('a worker whose heartbeat is old reads stale and is still listed', async () => {
    await register('old');
    f.t.clock.advance(10 * 60_000);
    await register('fresh');
    const body = await list();
    const byId = new Map(body.data.workers.map((w: { id: string }) => [w.id, w]));
    expect(byId.get('old')).toMatchObject({ status: 'stale' });
    expect(byId.get('fresh')).toMatchObject({ status: 'active' });
    expect(body.data.stats).toEqual({ total: 2, active: 1, stale: 1 });
  });

  test('removing a worker deletes its row', async () => {
    await register('w1');
    await register('w2');
    const answer = await api.call('DELETE', '/workers/w1');
    expect(answer).toMatchObject({ status: 200, body: { ok: true, removed: true } });
    const ids = (await list()).data.workers.map((w: { id: string }) => w.id);
    expect(ids).toEqual(['w2']);
  });

  test('removing a worker that is already gone is 200 with removed false', async () => {
    const answer = await api.call('DELETE', '/workers/never-was');
    expect(answer).toMatchObject({ status: 200, body: { ok: true, removed: false } });
  });

  test('a worker that is removed but still running registers again on its next heartbeat', async () => {
    await register('w1');
    await api.call('DELETE', '/workers/w1');
    expect(await f.store.workers.heartbeat('w1', { activeJobs: 0 })).toBe(false);
    await register('w1');
    expect((await list()).data.stats.total).toBe(1);
  });

  test('a viewer reads the workers and cannot remove one', async () => {
    await register('w1');
    expect((await api.asViewer('GET', '/workers')).status).toBe(200);
    expect((await api.asViewer('DELETE', '/workers/w1')).status).toBe(403);
    expect((await list()).data.stats.total).toBe(1);
  });
});
