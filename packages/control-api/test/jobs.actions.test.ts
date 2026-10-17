import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('jobs action routes', () => {
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

  const read = async (id: string) => (await api.call('GET', `/jobs/${id}`)).body.job;

  test('jobs data is replaced, and the version moves', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const before = await read(id!);
    const answer = await api.call('PUT', `/jobs/${id}/data`, { data: { fixed: true } });
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    const after = await read(id!);
    expect(after.data).toEqual({ fixed: true });
    expect(after.version).toBeGreaterThan(before.version);
  });

  test('jobs data with a stale expectedVersion is 409 and nothing changes', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const seen = (await read(id!)).version;
    await api.call('PUT', `/jobs/${id}/data`, { data: 'first', expectedVersion: seen });
    const stale = await api.call('PUT', `/jobs/${id}/data`, {
      data: 'second',
      expectedVersion: seen,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect((await read(id!)).data).toBe('first');
    const current = (await read(id!)).version;
    const ok = await api.call('PUT', `/jobs/${id}/data`, {
      data: 'third',
      expectedVersion: current,
    });
    expect(ok.status).toBe(200);
  });

  test('jobs data of an active job is changed and its lease is left alone', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    const answer = await api.call('PUT', `/jobs/${job.id}/data`, { data: 'edited' });
    expect(answer.status).toBe(200);
    const after = await read(job.id);
    expect(after).toMatchObject({ state: 'active', data: 'edited' });
    expect(after.lease).toMatchObject({ owner: 'w' });
  });

  test('jobs data of a finished job is 409 with its state, and an unknown job is 404', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    await f.store.complete(job.lease, 'ok');
    const done = await api.call('PUT', `/jobs/${job.id}/data`, { data: 'late' });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('job_state');
    expect(JSON.stringify(done.body.error.details)).toContain('completed');
    const missing = await api.call('PUT', '/jobs/nope/data', { data: 1 });
    expect(missing.status).toBe(404);
  });

  test('jobs data needs a data field and a known version type', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    expect((await api.call('PUT', `/jobs/${id}/data`, {})).status).toBe(400);
    expect(
      (await api.call('PUT', `/jobs/${id}/data`, { data: 1, expectedVersion: 'seven' })).status
    ).toBe(400);
  });

  test('jobs priority is changed on a waiting job and fenced by the version', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const seen = (await read(id!)).version;
    const answer = await api.call('PUT', `/jobs/${id}/priority`, {
      priority: 7,
      expectedVersion: seen,
    });
    expect(answer.status).toBe(200);
    expect(await read(id!)).toMatchObject({ priority: 7, state: 'prioritized' });
    const stale = await api.call('PUT', `/jobs/${id}/priority`, {
      priority: 1,
      expectedVersion: seen,
    });
    expect(stale.status).toBe(409);
    expect((await read(id!)).priority).toBe(7);
  });

  test('jobs priority of an active job is 409, and a changed lifo is not supported', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    const active = await api.call('PUT', `/jobs/${job.id}/priority`, { priority: 3 });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('job_state');
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const lifo = await api.call('PUT', `/jobs/${id}/priority`, { priority: 3, lifo: true });
    expect(lifo.status).toBe(501);
    expect(lifo.body.error.details.capability).toBe('lifo');
    expect((await read(id!)).priority).toBe(0);
  });

  test('jobs delay moves a delayed job and leaves the bell to the tick until it is due', async () => {
    const [id] = await enqueueN(f.store, 1, { delay: 60_000 }, 'q');
    const before = await read(id!);
    const answer = await api.call('PUT', `/jobs/${id}/delay`, { delay: 5_000 });
    expect(answer.status).toBe(200);
    const after = await read(id!);
    expect(after.state).toBe('delayed');
    expect(after.runAt).toBe(f.t.clock.now() + 5_000);
    expect(after.runAt).toBeLessThan(before.runAt);
    // The store's ring window is 0: a bell is rung when the job is due, by the tick.
    expect(f.transport.buffered('q')).toMatchObject({ ready: 0, delayed: 0 });
  });

  test('jobs delay of 0 makes the job due and rings it after the commit', async () => {
    const [id] = await enqueueN(f.store, 1, { delay: 60_000 }, 'q');
    const answer = await api.call('PUT', `/jobs/${id}/delay`, { delay: 0 });
    expect(answer.status).toBe(200);
    expect((await read(id!)).state).toBe('waiting');
    expect(f.transport.buffered('q').ready).toBe(1);
  });

  test('jobs delay of a job that is not delayed is 409', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const answer = await api.call('PUT', `/jobs/${id}/delay`, { delay: 5_000 });
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe('job_state');
  });

  test('jobs promote makes a delayed job due now and rings it', async () => {
    const [id] = await enqueueN(f.store, 1, { delay: 600_000 }, 'q');
    const answer = await api.call('POST', `/jobs/${id}/promote`);
    expect(answer.status).toBe(200);
    expect((await read(id!)).state).toBe('waiting');
    expect(f.transport.buffered('q').ready).toBe(1);
    const claimed = await f.store.claim('q', 'w', 1);
    expect(claimed.map((job) => job.id)).toEqual([id!]);
  });

  test('jobs promote with a stale version is 409 and the job stays delayed', async () => {
    const [id] = await enqueueN(f.store, 1, { delay: 600_000 }, 'q');
    const seen = (await read(id!)).version;
    await api.call('PUT', `/jobs/${id}/data`, { data: 'moved on' });
    const answer = await api.call('POST', `/jobs/${id}/promote`, { expectedVersion: seen });
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe('version_conflict');
    expect((await read(id!)).state).toBe('delayed');
  });

  test('jobs remove deletes a waiting job, fenced by expectedVersion in the query', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const seen = (await read(id!)).version;
    await api.call('PUT', `/jobs/${id}/data`, { data: 'edited' });
    const stale = await api.call('DELETE', `/jobs/${id}?expectedVersion=${seen}`);
    expect(stale.status).toBe(409);
    expect(await read(id!)).toMatchObject({ state: 'waiting' });
    const current = (await read(id!)).version;
    const removed = await api.call('DELETE', `/jobs/${id}?expectedVersion=${current}`);
    expect(removed).toMatchObject({ status: 200, body: { ok: true } });
    expect((await api.call('GET', `/jobs/${id}`)).status).toBe(404);
    expect((await api.call('DELETE', `/jobs/${id}`)).status).toBe(404);
  });

  test('jobs remove of an active job is 409 and the lease holder keeps it', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    const answer = await api.call('DELETE', `/jobs/${job.id}`);
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe('job_state');
    expect((await read(job.id)).state).toBe('active');
  });

  test('jobs actions with no store operation answer 501 naming the capability', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    for (const [action, capability] of [
      ['fail', 'job-fail'],
      ['discard', 'job-discard'],
      ['move-to-wait', 'job-retry'],
      ['move-to-delayed', 'job-move-to-delayed'],
    ] as const) {
      const answer = await api.call('POST', `/jobs/${id}/${action}`);
      expect(answer.status, action).toBe(501);
      expect(answer.body.error.code, action).toBe('not_supported');
      expect(answer.body.error.details.capability, action).toBe(capability);
    }
    expect((await read(id!)).state).toBe('waiting');
  });

  test('jobs actions need an operator: a viewer is 403 and changes nothing', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const before = await read(id!);
    const attempts: [string, string, unknown?][] = [
      ['PUT', `/jobs/${id}/data`, { data: 'x' }],
      ['PUT', `/jobs/${id}/priority`, { priority: 4 }],
      ['PUT', `/jobs/${id}/delay`, { delay: 10 }],
      ['POST', `/jobs/${id}/promote`],
      ['POST', `/jobs/${id}/logs`, { message: 'x' }],
      ['DELETE', `/jobs/${id}`],
    ];
    for (const [method, path, body] of attempts) {
      const answer = await api.asViewer(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
    expect(await read(id!)).toEqual(before);
  });
});
