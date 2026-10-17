import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

/** `alpha`: 3 waiting, 1 prioritized, 1 delayed, 1 active, 1 completed, 1 failed. `beta`: 2 waiting. */
async function seed(f: JobsFixture): Promise<{ failedId: string; activeId: string }> {
  const { store } = f;
  // The jobs that are claimed go in first: a claim takes the best waiting job, not the newest.
  const done = await claimOne(f.t, {}, 'alpha', 'w1');
  await store.complete(done.lease, { ok: true });
  const bad = await claimOne(f.t, { attempts: 1 }, 'alpha', 'w1');
  await store.fail(bad.lease, { message: 'boom', unrecoverable: true });
  const live = await claimOne(f.t, {}, 'alpha', 'w2');
  await enqueueN(store, 3, {}, 'alpha');
  await enqueueN(store, 1, { priority: 5 }, 'alpha');
  await enqueueN(store, 1, { delay: 60_000 }, 'alpha');
  await enqueueN(store, 2, {}, 'beta');
  return { failedId: bad.id, activeId: live.id };
}

describeDb('queues read routes', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());

  test('queues summary is the bare array the panel parses, one entry per queue', async () => {
    await seed(f);
    const answer = await f.api().call<unknown[]>('GET', '/queues/summary');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      {
        name: 'alpha',
        paused: false,
        counts: { waiting: 3, prioritized: 1, active: 1, completed: 1, failed: 1, delayed: 1 },
      },
      {
        name: 'beta',
        paused: false,
        counts: { waiting: 2, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      },
    ]);
    expect(answer.headers.get('x-next-cursor')).toBeNull();
  });

  test('queues summary pages with a cursor header and takes it back as after', async () => {
    await enqueueN(f.store, 1, {}, 'a');
    await enqueueN(f.store, 1, {}, 'b');
    await enqueueN(f.store, 1, {}, 'c');
    const { call } = f.api();
    const first = await call<{ name: string }[]>('GET', '/queues/summary?limit=2');
    expect(first.body.map((queue) => queue.name)).toEqual(['a', 'b']);
    const cursor = first.headers.get('x-next-cursor');
    expect(cursor).toBeString();
    const second = await call<{ name: string }[]>(
      'GET',
      `/queues/summary?limit=2&after=${encodeURIComponent(cursor!)}`
    );
    expect(second.body.map((queue) => queue.name)).toEqual(['c']);
    expect(second.headers.get('x-next-cursor')).toBeNull();
  });

  test('queues summary refuses a limit past the store page size', async () => {
    const answer = await f.api().call('GET', '/queues/summary?limit=100000');
    expect(answer.status).toBe(400);
  });

  test('queues counts and paused answer for a queue that has jobs and for one that has none', async () => {
    await seed(f);
    const { call } = f.api();
    const counts = await call('GET', '/queues/alpha/counts');
    expect(counts.body).toEqual({
      ok: true,
      counts: {
        waiting: 3,
        prioritized: 1,
        delayed: 1,
        active: 1,
        completed: 1,
        failed: 1,
        'waiting-children': 0,
        paused: 0,
      },
    });
    expect((await call('GET', '/queues/unknown/counts')).body.counts.waiting).toBe(0);
    expect((await call('GET', '/queues/alpha/paused')).body).toEqual({ ok: true, paused: false });
  });

  test('queues counts of a paused queue report what the pause holds back', async () => {
    await seed(f);
    const { call } = f.api();
    await call('POST', '/queues/alpha/pause');
    const answer = await call('GET', '/queues/alpha/counts');
    expect(answer.body.counts.paused).toBe(4);
    expect(answer.body.counts.waiting).toBe(3);
    expect((await call('GET', '/queues/alpha/paused')).body.paused).toBe(true);
    const summary = await call<{ name: string; paused: boolean }[]>('GET', '/queues/summary');
    expect(summary.body.find((queue) => queue.name === 'alpha')?.paused).toBe(true);
  });

  test('queues dashboard list gives the panel its row shape, paged', async () => {
    await seed(f);
    const { call } = f.api();
    const answer = await call('GET', '/dashboard/queues?limit=1&offset=1');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      queues: [{ name: 'beta', waiting: 2, delayed: 0, active: 0, dlq: 0, paused: false }],
      total: 2,
      limit: 1,
      offset: 1,
    });
    expect(answer.body.timestamp).toBeNumber();
    const all = await call('GET', '/dashboard/queues');
    expect(all.body.queues.map((queue: { name: string }) => queue.name)).toEqual(['alpha', 'beta']);
    expect(all.body.queues[0]).toMatchObject({ waiting: 3, delayed: 1, active: 1, dlq: 1 });
  });

  test('queues dashboard list refuses an offset it would have to walk for', async () => {
    const answer = await f.api().call('GET', '/dashboard/queues?offset=10001');
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe('offset_too_large');
  });

  test('queues dashboard page carries counts, priorities, the failed preview and the first jobs', async () => {
    const { failedId, activeId } = await seed(f);
    await f.store.control.updateProgress(activeId, 40);
    const answer = await f.api().call('GET', '/dashboard/queues/alpha');
    expect(answer.status).toBe(200);
    const page = answer.body;
    expect(page).toMatchObject({ ok: true, name: 'alpha', paused: false });
    expect(page.counts).toMatchObject({ waiting: 3, active: 1, failed: 1, paused: 0 });
    expect(page.priorityCounts).toEqual({ '0': 3, '5': 1 });
    expect(page.dlqPreview).toEqual([
      { id: failedId, data: expect.anything(), attempts: 1, createdAt: expect.any(Number) },
    ]);
    expect(page.jobs.waiting).toHaveLength(3);
    expect(page.jobs.delayed).toHaveLength(1);
    expect(page.jobs.paused).toEqual([]);
    expect(page.jobs.active).toEqual([
      expect.objectContaining({ id: activeId, progress: 40, attempts: expect.any(Number) }),
    ]);
  });

  test('queues dashboard page of a paused queue moves what is held into the paused list', async () => {
    await seed(f);
    const { call } = f.api();
    await call('POST', '/queues/alpha/pause');
    const { jobs } = (await call('GET', '/dashboard/queues/alpha')).body;
    expect(jobs.waiting).toEqual([]);
    expect(jobs.paused).toHaveLength(4);
    expect(jobs.active).toHaveLength(1);
  });

  test('queues dashboard page leaves the job lists out when asked', async () => {
    await seed(f);
    const answer = await f.api().call('GET', '/dashboard/queues/alpha?includeJobs=false');
    expect(answer.body.jobs).toBeUndefined();
    expect(answer.body.counts.waiting).toBe(3);
    expect((await f.api().call('GET', '/dashboard/queues/alpha?includeJobs=maybe')).status).toBe(
      400
    );
  });

  test('queues dashboard page of a queue with no jobs is empty, not 404', async () => {
    const answer = await f.api().call('GET', '/dashboard/queues/ghost');
    expect(answer.status).toBe(200);
    expect(answer.body.dlqPreview).toEqual([]);
    expect(answer.body.priorityCounts).toEqual({});
  });

  test('queues reads need a token, and a viewer may read', async () => {
    const api = f.api();
    expect((await api.api.call('GET', '/queues/summary', { token: null })).status).toBe(401);
    expect((await api.asViewer('GET', '/queues/summary')).status).toBe(200);
  });
});
