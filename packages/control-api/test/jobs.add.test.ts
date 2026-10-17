import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('jobs add routes', () => {
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

  const jobOf = async (id: string) => (await api.call('GET', `/jobs/${id}`)).body.job;

  test('jobs add stores the job with its options and rings the bell', async () => {
    const answer = await api.call('POST', '/queues/mail/jobs', {
      name: 'welcome',
      data: { to: 'a@b.c' },
      priority: 3,
      maxAttempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      timeout: 30_000,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, duplicated: false });
    const job = await jobOf(answer.body.id);
    expect(job).toMatchObject({
      queue: 'mail',
      name: 'welcome',
      data: { to: 'a@b.c' },
      priority: 3,
      state: 'prioritized',
      maxAttempts: 5,
      backoffConfig: { type: 'exponential', delay: 1_000 },
      timeout: 30_000,
    });
    expect(f.transport.buffered('mail').ready).toBe(1);
    expect(await f.store.claim('mail', 'w', 1)).toHaveLength(1);
  });

  test('jobs add without a name uses the default name, and null is data', async () => {
    const answer = await api.call('POST', '/queues/q/jobs', { data: null });
    expect(answer.status).toBe(200);
    expect(await jobOf(answer.body.id)).toMatchObject({ name: 'default', data: null });
  });

  test('jobs add with a delay is delayed and waits for the tick to ring it', async () => {
    const answer = await api.call('POST', '/queues/q/jobs', { data: 1, delay: 60_000 });
    const job = await jobOf(answer.body.id);
    expect(job.state).toBe('delayed');
    expect(job.runAt).toBe(f.t.clock.now() + 60_000);
    expect(f.transport.buffered('q').ready).toBe(0);
  });

  test('jobs add with a custom id answers the live job and says it was a duplicate', async () => {
    const first = await api.call('POST', '/queues/q/jobs', { data: 'a', jobId: 'order-1' });
    const second = await api.call('POST', '/queues/q/jobs', { data: 'b', jobId: 'order-1' });
    expect(first.body).toMatchObject({ id: 'order-1', duplicated: false });
    expect(second.body).toMatchObject({ id: 'order-1', duplicated: true });
    expect((await jobOf('order-1')).data).toBe('a');
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(1);
  });

  test('jobs add with a unique key keeps one live job for it', async () => {
    const first = await api.call('POST', '/queues/q/jobs', { data: 1, uniqueKey: 'sync-7' });
    const second = await api.call('POST', '/queues/q/jobs', { data: 2, uniqueKey: 'sync-7' });
    expect(second.body.duplicated).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect((await jobOf(first.body.id)).deduplicationId).toBe('sync-7');
  });

  test('jobs add keeps a group and a retention flag', async () => {
    const answer = await api.call('POST', '/queues/q/jobs', {
      data: 1,
      groupId: 'tenant-9',
      groupMaxSize: 2,
      removeOnComplete: true,
    });
    expect(await jobOf(answer.body.id)).toMatchObject({
      groupId: 'tenant-9',
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  test('jobs add decodes a tagged payload into the value it stands for', async () => {
    const answer = await api.call('POST', '/queues/q/jobs', {
      data: { big: { $type: 'bigint', value: '9007199254740993' } },
    });
    const stored = await f.store.control.details(answer.body.id);
    expect((stored!.data as { big: bigint }).big).toBe(9007199254740993n);
    expect((await jobOf(answer.body.id)).data).toEqual({
      big: { $type: 'bigint', value: '9007199254740993' },
    });
  });

  test('jobs add names the option this store has no equivalent for, and adds nothing', async () => {
    const unsupported: [string, Record<string, unknown>][] = [
      ['ttl', { ttl: 1_000 }],
      ['repeat', { repeat: { every: 1_000 } }],
      ['dependsOn', { dependsOn: ['x'] }],
      ['tags', { tags: ['a'] }],
      ['durable', { durable: false }],
      ['removeOnComplete', { removeOnComplete: 100 }],
      ['removeOnFail', { removeOnFail: 100 }],
    ];
    for (const [option, extra] of unsupported) {
      const answer = await api.call('POST', '/queues/q/jobs', { data: 1, ...extra });
      expect(answer.status, option).toBe(400);
      expect(answer.body.error.code, option).toBe('unsupported_option');
      expect(answer.body.error.details.option, option).toBe(option);
    }
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(0);
  });

  test('jobs add refuses a misspelt field, a missing payload and a bad type', async () => {
    const { call } = api;
    expect((await call('POST', '/queues/q/jobs', { data: 1, priorty: 2 })).status).toBe(400);
    expect((await call('POST', '/queues/q/jobs', { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/queues/q/jobs', { data: 1, priority: -1 })).status).toBe(400);
    expect((await call('POST', '/queues/q/jobs', { data: 1, maxAttempts: 0 })).status).toBe(400);
    expect((await call('POST', '/queues/q/jobs', { data: 1, groupMaxSize: 3 })).status).toBe(400);
  });

  test('jobs add in bulk keeps the order of its ids and rings each bell', async () => {
    const answer = await api.call('POST', '/queues/q/jobs/bulk', {
      jobs: [
        { data: 'a', customId: 'first' },
        { name: 'b', data: 'b', priority: 1 },
        { data: 'c', delay: 60_000 },
      ],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.ids).toHaveLength(3);
    expect(answer.body.ids[0]).toBe('first');
    expect(answer.body.duplicated).toEqual([]);
    expect((await jobOf(answer.body.ids[1])).name).toBe('b');
    expect((await jobOf(answer.body.ids[2])).state).toBe('delayed');
    expect(f.transport.buffered('q').ready).toBe(2);
  });

  test('jobs add in bulk reports which jobs were duplicates', async () => {
    await api.call('POST', '/queues/q/jobs', { data: 'old', jobId: 'dup' });
    const answer = await api.call('POST', '/queues/q/jobs/bulk', {
      jobs: [{ data: 'new' }, { data: 'again', customId: 'dup' }],
    });
    expect(answer.body.duplicated).toEqual([1]);
    expect(answer.body.ids[1]).toBe('dup');
  });

  test('jobs add in bulk is refused whole when one job is, and the index says which', async () => {
    const answer = await api.call('POST', '/queues/q/jobs/bulk', {
      jobs: [{ data: 1 }, { data: 2 }, { data: 3, ttl: 5 }],
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatchObject({
      code: 'unsupported_option',
      details: { option: 'ttl', index: 2 },
    });
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(0);
  });

  test('jobs add in bulk refuses an empty list and more jobs than the limit', async () => {
    const small = f.api({ summaryCacheMs: 0, maxBulkJobs: 2 });
    expect((await small.call('POST', '/queues/q/jobs/bulk', { jobs: [] })).status).toBe(400);
    const three = await small.call('POST', '/queues/q/jobs/bulk', {
      jobs: [{ data: 1 }, { data: 2 }, { data: 3 }],
    });
    expect(three.status).toBe(400);
  });

  test('jobs add needs an operator', async () => {
    const one = await api.asViewer('POST', '/queues/q/jobs', { data: 1 });
    const many = await api.asViewer('POST', '/queues/q/jobs/bulk', { jobs: [{ data: 1 }] });
    expect([one.status, many.status]).toEqual([403, 403]);
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(0);
  });
});
