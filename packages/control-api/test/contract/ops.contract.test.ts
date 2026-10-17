import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../../test/support/db';
import { claimOne } from '../../../store-postgres/test/finishHelpers';
import type { JobsApi, JobsFixture } from '../jobsFixture';
import { openJobsFixture } from '../jobsFixture';
import { FrameReader, openStream } from '../sse';
import {
  cronSchema,
  dlqConfigSchema,
  dlqEntrySchema,
  dlqStatsSchema,
  stallConfigSchema,
  workerSchema,
} from './shapes/ops-schemas';
import type { CreateCronBody } from './shapes/panel-ops-types';
import {
  activityPayload,
  parseFrame,
  SseConnectError,
  shouldDiscardLastEventId,
  statusFromEvent,
} from './shapes/panel-sse';
import { parseWorkersPayload } from './shapes/panel-workers';

/** A cron form with every field the panel's create dialog can send. */
const panelCron: CreateCronBody = {
  name: 'nightly-report',
  jobName: 'report',
  queue: 'q',
  data: { kind: 'report' },
  schedule: '0 3 * * *',
  timezone: 'Europe/London',
  priority: 5,
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: 100,
  uniqueKey: 'nightly',
  dedup: { ttl: 60_000, extend: false, replace: false },
  jobOptions: {
    maxAttempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    timeout: 30_000,
    stallTimeout: 45_000,
    removeOnComplete: true,
    removeOnFail: false,
  },
};

describeDb('DLQ, cron, workers and events: the panel reads what the service sends', () => {
  let f: JobsFixture;
  let api: JobsApi;

  beforeAll(async () => {
    f = await openJobsFixture();
    await f.reset();
    api = f.api({ summaryCacheMs: 0, events: { pollMs: 5, heartbeatMs: 100 } });
    for (const message of ['first failure', 'second failure']) {
      const job = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
      await f.store.fail(job.lease, { message, unrecoverable: true });
    }
    await f.store.workers.register({
      id: 'w-1',
      queues: ['q', 'other'],
      name: 'main',
      hostname: 'host-1',
      pid: 4242,
      concurrency: 4,
    });
    await f.store.workers.heartbeat('w-1', { activeJobs: 1, processed: 7, failed: 2 });
  }, 60_000);
  afterAll(() => f.drop());

  const get = async (path: string) => (await api.call('GET', path)).body;

  test('the DLQ page: entries, the total and the statistics', async () => {
    const body = await get('/queues/q/dlq?limit=50&offset=0');
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      const parsed = dlqEntrySchema.safeParse(entry);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    const stats = (await get('/queues/q/dlq/stats')).stats;
    expect(dlqStatsSchema.safeParse(stats).success).toBe(true);
    expect(stats).toMatchObject({ total: 2, byQueue: { q: 2 } });
  });

  test('the panel purge sends no confirmation yet, so it is refused until task 34 adapts it', async () => {
    const answer = await api.call('POST', '/queues/q/dlq/purge');
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe('confirmation_required');
    expect((await get('/queues/q/dlq')).total).toBe(2);
  });

  test('the queue settings: stall and DLQ configuration', async () => {
    const stall = (await get('/queues/q/stall-config')).config;
    expect(stallConfigSchema.safeParse(stall).success).toBe(true);
    const dlq = (await get('/queues/q/dlq-config')).config;
    expect(dlqConfigSchema.safeParse(dlq).success).toBe(true);
  });

  test('the workers page: the panel validation keeps every worker and quarantines none', async () => {
    const parsed = parseWorkersPayload(await get('/workers'));
    expect(parsed.data.quarantinedWorkers).toEqual([]);
    expect(parsed.data.workers).toHaveLength(1);
    expect(workerSchema.safeParse(parsed.data.workers[0]).success).toBe(true);
    expect(parsed.data.workers[0]).toMatchObject({
      id: 'w-1',
      name: 'main',
      queues: ['other', 'q'],
      status: 'active',
      activeJobs: 1,
      processedJobs: 7,
      failedJobs: 2,
    });
  });

  test('the cron page: a form with every field is accepted and reads back as the panel types it', async () => {
    const created = await api.call('POST', '/crons', panelCron);
    expect(created.status).toBe(201);
    expect(cronSchema.safeParse(created.body.cron).success).toBe(true);
    const listed = await get('/crons');
    expect(listed.ok).toBe(true);
    const row = listed.crons.find((cron: { name: string }) => cron.name === panelCron.name);
    expect(cronSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      queue: 'q',
      jobName: 'report',
      schedule: '0 3 * * *',
      timezone: 'Europe/London',
      maxLimit: 100,
      executions: 0,
      jobOptions: { maxAttempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
    });
    expect((await api.call('DELETE', `/crons/${panelCron.name}`)).status).toBe(200);
  });

  test('the activity stream: the panel decodes the handshake, each job event and the heartbeat', async () => {
    const response = await openStream(api.api, '/events/queues/live');
    expect(response.status).toBe(200);
    const reader = new FrameReader(response);
    try {
      const hello = parseFrame((await reader.nextRaw())!);
      expect(hello).toEqual({
        id: expect.stringMatching(/^\d+\.\d+$/),
        event: 'message',
        data: { connected: true },
      });

      const job = await claimOne(f.t, {}, 'live', 'w');
      await f.store.complete(job.lease, 'done');
      const seen: Array<{ event: string; status: string; id: string | undefined }> = [];
      while (seen.length < 3) {
        const frame = parseFrame((await reader.nextRaw())!);
        expect(frame).not.toBeNull();
        if (!frame!.event.startsWith('job:')) continue;
        const payload = activityPayload(frame!.data);
        expect(payload).toMatchObject({ queue: 'live', jobId: job.id });
        expect(Number.isFinite(payload.timestamp)).toBe(true);
        seen.push({ event: frame!.event, status: statusFromEvent(frame!.event), id: frame!.id });
      }
      expect(seen.map((entry) => entry.status)).toEqual(['waiting', 'active', 'completed']);
      expect(seen.every((entry) => entry.id !== undefined)).toBe(true);

      f.t.clock.advance(100);
      const quiet = await reader.nextRaw();
      expect(parseFrame(quiet!)).toBeNull();
    } finally {
      await reader.cancel();
    }
  });

  test('a refused resume is a status the panel treats as a stale checkpoint, and a capped stream is not', async () => {
    const end = await f.store.events.baseline();
    const cases: Array<[string, number]> = [
      ['not-a-cursor', 400],
      [`${end.commitSeq + 1_000}.1`, 409],
    ];
    for (const [id, status] of cases) {
      const answer = await openStream(api.api, '/events', { headers: { 'last-event-id': id } });
      expect(answer.status).toBe(status);
      expect(shouldDiscardLastEventId(new SseConnectError('refused', answer.status, true))).toBe(
        true
      );
    }
    const capped = f.api({ events: { maxPerPrincipal: 1 } });
    const first = await openStream(capped.api, '/events');
    try {
      const second = await openStream(capped.api, '/events');
      expect(second.status).toBe(429);
      expect(shouldDiscardLastEventId(new SseConnectError('busy', second.status, true))).toBe(
        false
      );
    } finally {
      await first.body?.cancel();
    }
  });
});
