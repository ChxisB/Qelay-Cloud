import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
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

  test('changing retention or turning auto-retry on is 501 and leaves the config', async () => {
    const read = (await dlq()).body.config;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['dlq-retention', { maxAge: 1_000 }],
      ['dlq-retention', { maxEntries: read.maxEntries + 1 }],
      ['dlq-auto-retry', { autoRetry: true }],
    ];
    for (const [capability, body] of cases) {
      const answer = await api.call('PUT', '/queues/q/dlq-config', { config: body });
      expect(answer.status, capability).toBe(501);
      expect(answer.body.error.details.capability).toBe(capability);
    }
    expect((await dlq()).body.config).toEqual(read);
    const unsupported = (await api.call('GET', '/capabilities')).body.unsupported;
    expect(unsupported).toEqual(expect.arrayContaining(['dlq-retention', 'dlq-auto-retry']));
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
