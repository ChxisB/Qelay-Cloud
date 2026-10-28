import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('stall and DLQ configuration routes', () => {
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

  const stall = (queue = 'q') => api.call('GET', `/queues/${queue}/stall-config`);
  const dlq = (queue = 'q') => api.call('GET', `/queues/${queue}/dlq-config`);

  test('stall config reads the lease and the stall limit of a queue never configured', async () => {
    const answer = await stall();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      ok: true,
      config: { enabled: true, stallInterval: f.store.leaseMs, maxStalls: 3, gracePeriod: 0 },
    });
  });

  test('maxStalls is saved bare or wrapped in config', async () => {
    const bare = await api.call('PUT', '/queues/q/stall-config', { maxStalls: 4 });
    expect(bare).toMatchObject({ status: 200, body: { ok: true, config: { maxStalls: 4 } } });
    const wrapped = await api.call('PUT', '/queues/q/stall-config', { config: { maxStalls: 7 } });
    expect(wrapped.body.config.maxStalls).toBe(7);
    expect((await stall()).body.config.maxStalls).toBe(7);
    expect((await stall('other')).body.config.maxStalls).toBe(3);
  });

  test('a form that sends the fixed fields back as read is accepted', async () => {
    const read = (await stall()).body.config;
    const saved = await api.call('PUT', '/queues/q/stall-config', {
      config: { ...read, maxStalls: 3 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toEqual({ ...read, maxStalls: 3 });
  });

  test('a fixed field that changes is 400 naming the option, and nothing is saved', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['enabled', { enabled: false }],
      ['stallInterval', { stallInterval: f.store.leaseMs + 1 }],
      ['gracePeriod', { gracePeriod: 5_000 }],
    ];
    for (const [option, body] of cases) {
      const answer = await api.call('PUT', '/queues/q/stall-config', { ...body, maxStalls: 9 });
      expect(answer.status, option).toBe(400);
      expect(answer.body.error.code, option).toBe('unsupported_option');
      expect(answer.body.error.details.option, option).toBe(option);
    }
    expect((await stall()).body.config.maxStalls).toBe(3);
  });

  test('stall config refuses an unknown key and a value the store does not take', async () => {
    const unknown = await api.call('PUT', '/queues/q/stall-config', { retries: 3 });
    expect(unknown.status).toBe(400);
    const negative = await api.call('PUT', '/queues/q/stall-config', { maxStalls: -1 });
    expect(negative.status).toBe(400);
    const fraction = await api.call('PUT', '/queues/q/stall-config', { maxStalls: 1.5 });
    expect(fraction.status).toBe(400);
  });

  test('DLQ config reads the fixed auto-retry and the queue retention', async () => {
    const answer = await dlq();
    expect(answer.status).toBe(200);
    expect(answer.body.config).toMatchObject({
      autoRetry: false,
      autoRetryInterval: 3_600_000,
      maxAutoRetries: 3,
    });
    expect(typeof answer.body.config.maxEntries).toBe('number');
  });

  test('a form that sends the DLQ config back as read is a no-op, bare or wrapped', async () => {
    const read = (await dlq()).body.config;
    for (const body of [read, { config: read }]) {
      const saved = await api.call('PUT', '/queues/q/dlq-config', body);
      expect(saved).toMatchObject({ status: 200, body: { ok: true, config: read } });
    }
  });

  test('retention is saved, bare or wrapped, and only the keys that changed are audited', async () => {
    const read = (await dlq()).body.config;
    const wrapped = await api.call('PUT', '/queues/q/dlq-config', {
      config: { ...read, maxAge: 3_600_000, maxEntries: 50 },
    });
    expect(wrapped).toMatchObject({
      status: 200,
      body: { ok: true, config: { maxAge: 3_600_000, maxEntries: 50 } },
    });
    const bare = await api.call('PUT', '/queues/q/dlq-config', { maxAge: null });
    expect(bare.body.config).toMatchObject({ maxAge: null, maxEntries: 50 });
    expect((await dlq()).body.config).toMatchObject({ maxAge: null, maxEntries: 50 });
    expect((await dlq('other')).body.config).toEqual(read);
    const [entry] = (await f.store.audit.list({ limit: 1 })).items;
    expect(entry).toMatchObject({ action: 'PUT /queues/:queue/dlq-config', status: 200 });
  });

  test('a retention value the store does not take is 400 and nothing is saved', async () => {
    const read = (await dlq()).body.config;
    for (const body of [{ maxEntries: 0 }, { maxAge: 0 }, { maxAge: 1.5 }, { maxEntries: 1.5 }]) {
      const answer = await api.call('PUT', '/queues/q/dlq-config', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect((await dlq()).body.config).toEqual(read);
  });

  test('turning auto-retry on is 501 and leaves the config', async () => {
    const read = (await dlq()).body.config;
    const answer = await api.call('PUT', '/queues/q/dlq-config', {
      config: { autoRetry: true, maxAge: 1_000 },
    });
    expect(answer.status).toBe(501);
    expect(answer.body.error.details.capability).toBe('dlq-auto-retry');
    expect((await dlq()).body.config).toEqual(read);
    const unsupported = (await api.call('GET', '/capabilities')).body.unsupported;
    expect(unsupported).toContain('dlq-auto-retry');
    expect(unsupported).not.toContain('dlq-retention');
  });

  test('lowering maxEntries trims the DLQ to the new limit at once, oldest first', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const job = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
      await f.store.fail(job.lease, { message: 'x', unrecoverable: true });
      ids.push(job.id);
    }
    const saved = await api.call('PUT', '/queues/q/dlq-config', { maxEntries: 1 });
    expect(saved.body.config.maxEntries).toBe(1);
    const left = (await api.call('GET', '/queues/q/dlq')).body.entries;
    expect(left.map((entry: { job: { id: string } }) => entry.job.id)).toEqual([ids[2]]);
  });

  test('a different auto-retry interval or count is 400 naming the option', async () => {
    const interval = await api.call('PUT', '/queues/q/dlq-config', { autoRetryInterval: 1_000 });
    expect(interval.status).toBe(400);
    expect(interval.body.error.details.option).toBe('autoRetryInterval');
    const count = await api.call('PUT', '/queues/q/dlq-config', { maxAutoRetries: 99 });
    expect(count.status).toBe(400);
    expect(count.body.error.details.option).toBe('maxAutoRetries');
  });

  test('a viewer reads both configs and cannot save either', async () => {
    expect((await api.asViewer('GET', '/queues/q/stall-config')).status).toBe(200);
    expect((await api.asViewer('GET', '/queues/q/dlq-config')).status).toBe(200);
    for (const path of ['/queues/q/stall-config', '/queues/q/dlq-config']) {
      expect((await api.asViewer('PUT', path, { maxStalls: 2 })).status, path).toBe(403);
    }
    expect((await stall()).body.config.maxStalls).toBe(3);
  });
});

describeDb('queue policy routes', () => {
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

  const POLICY = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000, maxDelay: 600_000 },
    timeout: 30_000,
  };

  test('a queue with no policy says null, and a saved one is read back; another queue has none', async () => {
    expect((await api.call('GET', '/queues/q/policy')).body).toEqual({ ok: true, policy: null });
    const saved = await api.call('PUT', '/queues/q/policy', POLICY);
    expect(saved).toMatchObject({ status: 200, body: { ok: true, policy: POLICY } });
    expect((await api.call('GET', '/queues/q/policy')).body.policy).toEqual(POLICY);
    expect((await api.call('GET', '/queues/other/policy')).body.policy).toBeNull();
  });

  test('a number backoff is stored as a fixed one, and {} removes the policy', async () => {
    const saved = await api.call('PUT', '/queues/q/policy', { backoff: 2_000 });
    expect(saved.body.policy).toEqual({ backoff: { type: 'fixed', delay: 2_000 } });
    const removed = await api.call('PUT', '/queues/q/policy', {});
    expect(removed).toMatchObject({ status: 200, body: { ok: true, policy: null } });
    expect((await api.call('GET', '/queues/q/policy')).body.policy).toBeNull();
  });

  test('a job added afterwards gets the policy', async () => {
    await api.call('PUT', '/queues/q/policy', { attempts: 4 });
    const [job] = await f.store.enqueue([{ queue: 'q', data: 1 }]);
    const read = await api.call('GET', `/jobs/${job!.id}`);
    expect(read.body.job.maxAttempts).toBe(4);
  });

  test('an invalid policy is 400 unsupported_option naming the field, and the stored one stays', async () => {
    await api.call('PUT', '/queues/q/policy', POLICY);
    for (const [body, option] of [
      [{ attempts: 0 }, 'attempts'],
      [{ timeout: -1 }, 'timeout'],
      [{ backoff: { type: 'linear', delay: 1 } }, 'backoff.type'],
      [{ backoff: { type: 'fixed', delay: 1, jitter: true } }, 'backoff.jitter'],
      [{ priority: 3 }, 'priority'],
    ] as const) {
      const answer = await api.call('PUT', '/queues/q/policy', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error).toMatchObject({ code: 'unsupported_option', details: { option } });
    }
    expect((await api.call('GET', '/queues/q/policy')).body.policy).toEqual(POLICY);
  });

  test('a body that is not an object is 400', async () => {
    for (const body of [[1], 'daily', null]) {
      expect((await api.call('PUT', '/queues/q/policy', body)).status).toBe(400);
    }
  });

  test('a save is audited, with the settings it set', async () => {
    await api.call('PUT', '/queues/q/policy', { attempts: 2, timeout: 1_000 });
    const [entry] = (await f.store.audit.list({ limit: 1 })).items;
    expect(entry).toMatchObject({ action: 'PUT /queues/:queue/policy', status: 200 });
    expect(JSON.stringify(entry)).toContain('policy attempts,timeout');
  });
});
