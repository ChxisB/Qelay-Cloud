import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('jobs read routes', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());

  test('jobs list pages by offset with the total, in state order', async () => {
    await enqueueN(f.store, 5, {}, 'q');
    await enqueueN(f.store, 2, { delay: 60_000 }, 'q');
    const { call } = f.api();
    const first = await call('GET', '/queues/q/jobs/list?limit=3');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, limit: 3, offset: 0, total: 7 });
    expect(first.body.jobs.map((job: { data: number }) => job.data)).toEqual([0, 1, 2]);
    const last = await call('GET', '/queues/q/jobs/list?limit=3&offset=6');
    expect(last.body.jobs).toHaveLength(1);
    expect(last.body.jobs[0].state).toBe('delayed');
    const delayed = await call('GET', '/queues/q/jobs/list?states=delayed');
    expect(delayed.body.total).toBe(2);
    expect(delayed.body.jobs.every((job: { state: string }) => job.state === 'delayed')).toBe(true);
  });

  test('jobs list walks a queue with the cursor and ends with next null', async () => {
    await enqueueN(f.store, 5, {}, 'q');
    const { call } = f.api();
    const seen: number[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const answer = await call('GET', `/queues/q/jobs/list?limit=2&cursor=${cursor}`);
      expect(answer.status).toBe(200);
      seen.push(...answer.body.jobs.map((job: { data: number }) => job.data));
      if (answer.body.next === null) break;
      cursor = encodeURIComponent(answer.body.next);
    }
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test('jobs list refuses an unknown state and an offset past the bound', async () => {
    const { call } = f.api({ summaryCacheMs: 0, maxOffset: 100 });
    const state = await call('GET', '/queues/q/jobs/list?states=sleeping');
    expect(state.status).toBe(400);
    expect(state.body.error.details.allowed).toContain('waiting');
    const offset = await call('GET', '/queues/q/jobs/list?offset=101');
    expect(offset.status).toBe(400);
    expect(offset.body.error).toMatchObject({
      code: 'offset_too_large',
      details: { maxOffset: 100, use: 'cursor' },
    });
  });

  test('jobs list clamps the page size to the configured maximum', async () => {
    await enqueueN(f.store, 6, {}, 'q');
    const answer = await f
      .api({ summaryCacheMs: 0, maxPageSize: 4 })
      .call('GET', '/queues/q/jobs/list?limit=500');
    expect(answer.body.limit).toBe(4);
    expect(answer.body.jobs).toHaveLength(4);
  });

  test('jobs detail is the panel job with its version, and a custom id finds the same job', async () => {
    const [id] = await f.store.enqueue([
      {
        queue: 'q',
        name: 'email',
        data: { to: 'a@b.c' },
        options: { jobId: 'order-17', priority: 2, attempts: 4, timeout: 5_000 },
      },
    ]);
    const { call } = f.api();
    const byId = await call('GET', `/jobs/${id!.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.ok).toBe(true);
    expect(byId.body.job).toMatchObject({
      id: 'order-17',
      queue: 'q',
      name: 'email',
      data: { to: 'a@b.c' },
      state: 'prioritized',
      priority: 2,
      maxAttempts: 4,
      attempts: 0,
      timeout: 5_000,
      customId: 'order-17',
      version: 0,
      lease: null,
      truncated: false,
      progress: 0,
    });
    const byCustom = await call('GET', '/jobs/custom/order-17');
    expect(byCustom.body.job).toEqual(byId.body.job);
  });

  test('jobs detail of a completed job carries its return value and timeline', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    f.t.clock.advance(1_000);
    await f.store.complete(job.lease, { answer: 42 });
    const { call } = f.api();
    const answer = await call('GET', `/jobs/${job.id}`);
    expect(answer.body.job).toMatchObject({
      state: 'completed',
      returnvalue: { answer: 42 },
      result: { answer: 42 },
    });
    expect(answer.body.job.timeline.map((entry: { state: string }) => entry.state)).toEqual([
      'created',
      'active',
      'completed',
    ]);
    expect((await call('GET', `/jobs/${job.id}/result`)).body).toEqual({
      ok: true,
      id: job.id,
      result: { answer: 42 },
      truncated: false,
    });
  });

  test('jobs detail of a failed job carries the reason and the failed attempt', async () => {
    const job = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
    await f.store.fail(job.lease, { message: 'upstream said no', unrecoverable: true });
    const answer = await f.api().call('GET', `/jobs/${job.id}`);
    expect(answer.body.job).toMatchObject({ state: 'failed', failedReason: 'upstream said no' });
    expect(answer.body.job.timeline).toContainEqual(
      expect.objectContaining({ state: 'failed', error: 'upstream said no' })
    );
  });

  test('jobs result of a job that has none is null', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const answer = await f.api().call('GET', `/jobs/${id}/result`);
    expect(answer.body).toEqual({ ok: true, id, result: null, truncated: false });
  });

  test('jobs children of a job without a flow are an empty map', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const answer = await f.api().call('GET', `/jobs/${id}/children`);
    expect(answer.body).toEqual({ ok: true, data: { values: {} } });
  });

  test('jobs that do not exist are 404 on every read', async () => {
    const { call } = f.api();
    for (const path of [
      '/jobs/nope',
      '/jobs/custom/nope',
      '/jobs/nope/result',
      '/jobs/nope/logs',
      '/jobs/nope/children',
    ]) {
      const answer = await call('GET', path);
      expect(answer.status, path).toBe(404);
      expect(answer.body.error.code, path).toBe('job_not_found');
    }
  });

  test('jobs logs are added in order, listed with their count, and cleared', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const { call } = f.api();
    expect((await call('POST', `/jobs/${id}/logs`, { message: 'one' })).body).toEqual({ ok: true });
    await call('POST', `/jobs/${id}/logs`, { message: 'two', level: 'warn' });
    const list = await call('GET', `/jobs/${id}/logs`);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.count).toBe(2);
    expect(list.body.data.logs.map((entry: { message: string }) => entry.message)).toEqual([
      'one',
      'two',
    ]);
    expect(list.body.data.logs[1].level).toBe('warn');
    expect((await call('DELETE', `/jobs/${id}/logs`)).body).toEqual({ ok: true, count: 2 });
    expect((await call('GET', `/jobs/${id}/logs`)).body.data.count).toBe(0);
    expect((await call('POST', '/jobs/nope/logs', { message: 'x' })).status).toBe(404);
  });

  test('jobs progress is written without moving the version', async () => {
    const job = await claimOne(f.t, {}, 'q', 'w');
    const { call } = f.api();
    const before = (await call('GET', `/jobs/${job.id}`)).body.job.version;
    const answer = await call('POST', `/jobs/${job.id}/progress`, {
      progress: 60,
      message: 'half',
    });
    expect(answer.body).toEqual({ ok: true });
    const after = (await call('GET', `/jobs/${job.id}`)).body.job;
    expect(after).toMatchObject({ progress: 60, progressMessage: 'half', version: before });
  });

  test('jobs detail cuts a payload at the budget and marks it, and a list cuts at its own', async () => {
    const big = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`k${i}`, 'v'.repeat(40)])
    );
    const [id] = await f.store.enqueue([{ queue: 'q', data: big }]);
    const api = f.api({ summaryCacheMs: 0, detailPayloadBytes: 4_000, listPayloadBytes: 500 });
    const one = await api.call('GET', `/jobs/${id!.id}`);
    expect(one.body.job.truncated).toBe(true);
    expect(one.body.job.data).toMatchObject({ $type: 'truncated', kind: 'object', length: 300 });
    const roomy = f.api({ summaryCacheMs: 0, detailPayloadBytes: 1_000_000 });
    const whole = await roomy.call('GET', `/jobs/${id!.id}`);
    expect(whole.body.job.truncated).toBe(false);
    expect(Object.keys(whole.body.job.data)).toHaveLength(300);
    const list = await api.call('GET', '/queues/q/jobs/list');
    expect(list.body.jobs[0].truncated).toBe(true);
    expect(JSON.stringify(list.body).length).toBeLessThan(2_000);
  });

  test('jobs data round-trips bigint, date, bytes, map and set through the tagged form', async () => {
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const data = {
      big: { $type: 'bigint', value: '9007199254740993' },
      when: { $type: 'date', value: '2026-10-15T08:30:00.123Z' },
      raw: { $type: 'bytes', base64: 'AAH+/w==' },
      table: { $type: 'map', entries: [['a', 1]] },
      group: { $type: 'set', values: [1, 2, 3] },
      plain: { nested: [1, 'two', null, true] },
    };
    const { call } = f.api();
    expect((await call('PUT', `/jobs/${id}/data`, { data })).body).toEqual({ ok: true });
    expect((await call('GET', `/jobs/${id}`)).body.job.data).toEqual(data);
    const stored = await f.store.control.details(id!);
    const kept = stored!.data as Record<string, unknown>;
    expect(kept.big).toBe(9007199254740993n);
    expect(kept.when).toEqual(new Date('2026-10-15T08:30:00.123Z'));
    expect(kept.raw).toEqual(new Uint8Array([0, 1, 254, 255]));
    expect(kept.table).toEqual(new Map([['a', 1]]));
    expect(kept.group).toEqual(new Set([1, 2, 3]));
  });
});
