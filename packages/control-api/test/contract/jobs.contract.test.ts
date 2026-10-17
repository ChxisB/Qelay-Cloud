import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../../test/support/db';
import { claimOne } from '../../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from '../jobsFixture';
import { openJobsFixture } from '../jobsFixture';
import {
  jobFullSchema,
  jobListItemSchema,
  queueCountsSchema,
  queueDetailSchema,
  queuesResponseSchema,
  queueSummaryRowSchema,
} from './shapes/jobs-schemas';
import { parseQueueSummaryPayload } from './shapes/panel-consumers';
import { jobFromEnvelope, resultFromEnvelope } from './shapes/panel-job-validation';

/** The ids of the jobs the suite seeds, by what they are. */
interface Seeded {
  readonly completed: string;
  readonly failed: string;
  readonly active: string;
  readonly prioritized: string;
  readonly delayed: string;
  readonly custom: string;
  readonly exhausted: string;
}

describeDb('queues and jobs: the panel reads what the service sends', () => {
  let f: JobsFixture;
  let api: JobsApi;
  let ids: Seeded;

  beforeAll(async () => {
    f = await openJobsFixture();
    await f.reset();
    api = f.api();
    const done = await claimOne(f.t, { jobId: 'finished' }, 'q', 'w');
    await f.store.complete(done.lease, { answer: 42, when: new Date(1_000) });
    const bad = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
    await f.store.fail(bad.lease, { message: 'boom', unrecoverable: true });
    const active = await claimOne(f.t, {}, 'q', 'w');
    const [custom] = await enqueueN(f.store, 1, { jobId: 'order-7' }, 'q');
    const [prioritized] = await enqueueN(f.store, 1, { priority: 5 }, 'q');
    const [delayed] = await enqueueN(f.store, 1, { delay: 60_000 }, 'q');
    // A job that failed twenty-five times: its history is longer than the panel's timeline.
    const [exhausted] = await enqueueN(
      f.store,
      1,
      { attempts: 25, backoff: { type: 'fixed', delay: 0 } },
      'retries'
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const [claimed] = await f.store.claim('retries', 'w', 1);
      await f.store.fail(claimed!.lease, { message: `attempt ${attempt}`, unrecoverable: false });
    }
    ids = {
      completed: done.id,
      failed: bad.id,
      active: active.id,
      prioritized: prioritized!,
      delayed: delayed!,
      custom: custom!,
      exhausted: exhausted!,
    };
  }, 60_000);
  afterAll(() => f.drop());

  const get = async (path: string) => (await api.call('GET', path)).body;

  test('queues summary passes the panel parser, and each row fits its type', async () => {
    const body = await get('/queues/summary');
    const rows = parseQueueSummaryPayload(body);
    expect(rows.map((row) => row.name)).toEqual(['q', 'retries']);
    for (const row of rows) expect(queueSummaryRowSchema.safeParse(row).success).toBe(true);
  });

  test('queues counts and paused fit what the queue page reads', async () => {
    const counts = await get('/queues/q/counts');
    expect(counts.ok).toBe(true);
    expect(queueCountsSchema.safeParse(counts.counts).success).toBe(true);
    const paused = await get('/queues/q/paused');
    expect(paused).toMatchObject({ ok: true, paused: false });
  });

  test('queues dashboard list and queue page fit the panel types', async () => {
    const list = await get('/dashboard/queues?limit=10&offset=0');
    expect(queuesResponseSchema.safeParse(list).success).toBe(true);
    const page = await get('/dashboard/queues/q?includeJobs=true');
    const parsed = queueDetailSchema.safeParse(page);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const plain = await get('/dashboard/queues/q?includeJobs=false');
    expect(queueDetailSchema.safeParse(plain).success).toBe(true);
    expect(plain.jobs).toBeUndefined();
  });

  test('jobs list: every job fits the panel type and passes the inspector validation', async () => {
    const body = await get('/queues/q/jobs/list?limit=50');
    expect(body.ok).toBe(true);
    expect(body.jobs.length).toBeGreaterThanOrEqual(6);
    for (const job of body.jobs) {
      const parsed = jobListItemSchema.safeParse(job);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(() => jobFromEnvelope({ ok: true, job }, { canonical: true })).not.toThrow();
    }
  });

  test('jobs detail of each state passes the inspector validation and fits JobFull', async () => {
    for (const [what, id] of Object.entries(ids)) {
      const body = await get(`/jobs/${id}`);
      const parsed = jobFullSchema.safeParse(body.job);
      expect(parsed.success, `${what}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      const job = jobFromEnvelope(body, { canonical: true, expectedId: id });
      expect(job?.id, what).toBe(id);
    }
  });

  test('jobs detail of a job that failed twenty-five times has a timeline the panel accepts', async () => {
    const { job } = await get(`/jobs/${ids.exhausted}`);
    expect(job.state).toBe('failed');
    expect(job.timeline.length).toBeLessThanOrEqual(20);
    expect(job.timeline[0].state).toBe('created');
    expect(() => jobFromEnvelope({ ok: true, job }, { canonical: true })).not.toThrow();
  });

  test('jobs by custom id answers what the inspector resolves to the same job', async () => {
    const body = await get('/jobs/custom/order-7');
    const candidate = jobFromEnvelope(body, { canonical: false });
    expect(candidate?.customId).toBe('order-7');
    expect(candidate?.id).toBe(ids.custom);
    const resolved = await get(`/jobs/${candidate!.id}`);
    expect(jobFromEnvelope(resolved, { canonical: true, expectedId: candidate!.id })?.id).toBe(
      ids.custom
    );
  });

  test('jobs result is the envelope the inspector falls back to', async () => {
    for (const id of [ids.completed, ids.delayed]) {
      const body = await get(`/jobs/${id}/result`);
      expect(() => resultFromEnvelope(body, id), id).not.toThrow();
    }
    const done = resultFromEnvelope(await get(`/jobs/${ids.completed}/result`), ids.completed);
    expect(done.result).toMatchObject({ answer: 42 });
  });

  test('jobs logs and children keep the nesting the job page reads', async () => {
    await api.call('POST', `/jobs/${ids.active}/logs`, { message: 'hello', level: 'info' });
    const logs = await get(`/jobs/${ids.active}/logs`);
    expect(logs.ok).toBe(true);
    expect(Array.isArray(logs.data.logs)).toBe(true);
    expect(logs.data.count).toBe(logs.data.logs.length);
    const children = await get(`/jobs/${ids.active}/children`);
    expect(children).toMatchObject({ ok: true, data: { values: {} } });
  });

  test('jobs add answers the ids the add page reads', async () => {
    const one = await api.call('POST', '/queues/added/jobs', { name: 'a', data: { x: 1 } });
    expect(one.body).toMatchObject({ ok: true, duplicated: false });
    expect(typeof one.body.id).toBe('string');
    const many = await api.call('POST', '/queues/added/jobs/bulk', {
      jobs: [{ data: 1 }, { data: 2 }],
    });
    expect(many.body.ok).toBe(true);
    expect(many.body.ids).toHaveLength(2);
    expect(many.body.ids.every((id: unknown) => typeof id === 'string')).toBe(true);
  });
});
