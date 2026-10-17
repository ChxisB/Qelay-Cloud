import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { START } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('cron routes', () => {
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

  const every = { name: 'tick', queue: 'q', repeatEvery: 60_000 };
  const crons = async () => (await api.call('GET', '/crons')).body;

  test('creating a cron answers 201 with the cron and when it is next due', async () => {
    const answer = await api.call('POST', '/crons', {
      name: 'report',
      queue: 'q',
      schedule: '*/5 * * * *',
      jobName: 'build-report',
      priority: 2,
      maxLimit: 10,
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      ok: true,
      cron: {
        name: 'report',
        queue: 'q',
        jobName: 'build-report',
        schedule: '*/5 * * * *',
        repeatEvery: null,
        timezone: null,
        priority: 2,
        maxLimit: 10,
        executions: 0,
        exhausted: false,
        skipMissedOnRestart: true,
      },
    });
    const { nextRun } = answer.body.cron;
    expect(nextRun).toBeGreaterThan(START);
    expect(nextRun - START).toBeLessThanOrEqual(5 * 60_000);
    expect(nextRun % (5 * 60_000)).toBe(0);
  });

  test('an interval cron is next due one interval from now', async () => {
    const answer = await api.call('POST', '/crons', every);
    expect(answer.status).toBe(201);
    expect(answer.body.cron).toMatchObject({
      schedule: null,
      repeatEvery: 60_000,
      nextRun: START + 60_000,
    });
  });

  test('accepts the expressions Qelay accepts: five fields, six fields, names and shortcuts', async () => {
    const accepted = [
      '* * * * *',
      '0 9 * * 1-5',
      '*/15 0-6,18-23 1,15 * *',
      '30 4 1 jan,jul *',
      '0 0 * * mon',
      '*/10 * * * * *',
      '@hourly',
      '@daily',
      '@weekly',
    ];
    for (const [index, schedule] of accepted.entries()) {
      const answer = await api.call('POST', '/crons', { name: `c${index}`, queue: 'q', schedule });
      expect(answer.status, schedule).toBe(201);
      expect(answer.body.cron.nextRun, schedule).toBeGreaterThan(START);
    }
    expect((await crons()).total).toBe(accepted.length);
  });

  test('a time zone moves the occurrence it is next due at', async () => {
    const utc = await api.call('POST', '/crons', { name: 'a', queue: 'q', schedule: '0 9 * * *' });
    const tokyo = await api.call('POST', '/crons', {
      name: 'b',
      queue: 'q',
      schedule: '0 9 * * *',
      timezone: 'Asia/Tokyo',
    });
    expect(tokyo.status).toBe(201);
    expect(tokyo.body.cron.timezone).toBe('Asia/Tokyo');
    expect(tokyo.body.cron.nextRun).not.toBe(utc.body.cron.nextRun);
  });

  test('invalid definitions are 400 unsupported_option naming the option, and nothing is written', async () => {
    const base = { name: 'bad', queue: 'q' };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['not an expression', { ...base, schedule: 'every day' }, 'schedule'],
      ['minute out of range', { ...base, schedule: '61 * * * *' }, 'schedule'],
      ['hour out of range', { ...base, schedule: '0 25 * * *' }, 'schedule'],
      ['too few fields', { ...base, schedule: '* * * *' }, 'schedule'],
      ['too many fields', { ...base, schedule: '* * * * * * *' }, 'schedule'],
      ['empty', { ...base, schedule: '   ' }, 'schedule'],
      ['unknown zone', { ...base, schedule: '* * * * *', timezone: 'Mars/Phobos' }, 'schedule'],
      ['both timings', { ...base, schedule: '* * * * *', repeatEvery: 1_000 }, 'schedule'],
      ['no timing', { ...base }, 'schedule'],
      ['zero interval', { ...base, repeatEvery: 0 }, 'repeatEvery'],
      ['fractional interval', { ...base, repeatEvery: 1.5 }, 'repeatEvery'],
      ['interval over a year', { ...base, repeatEvery: 400 * 86_400_000 }, 'repeatEvery'],
      ['zone on an interval', { ...base, repeatEvery: 1_000, timezone: 'UTC' }, 'timezone'],
      ['limit of zero', { ...base, repeatEvery: 1_000, maxLimit: 0 }, 'maxLimit'],
      [
        'dedup without a key to dedup on',
        { ...base, repeatEvery: 1_000, preventOverlap: false, dedup: { ttl: 5 } },
        'dedup',
      ],
      [
        'missed occurrences made up',
        { ...base, repeatEvery: 1_000, skipMissedOnRestart: false },
        'skipMissedOnRestart',
      ],
    ];
    for (const [label, body, option] of cases) {
      const answer = await api.call('POST', '/crons', body);
      expect(answer.status, label).toBe(400);
      expect(answer.body.error.code, label).toBe('unsupported_option');
      expect(answer.body.error.details.option, label).toBe(option);
      expect(typeof answer.body.error.message, label).toBe('string');
    }
    expect((await crons()).total).toBe(0);
  });

  test('a body with a key the API does not have, or a wrong type, is 400', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown key', { ...every, cronExpression: '* * * * *' }],
      ['unknown template key', { ...every, jobOptions: { lifo: true } }],
      ['template attempts is maxAttempts', { ...every, jobOptions: { attempts: 3 } }],
      ['no queue', { name: 'x', repeatEvery: 1_000 }],
      ['no name', { queue: 'q', repeatEvery: 1_000 }],
      ['name is a number', { ...every, name: 7 }],
      ['priority is negative', { ...every, priority: -1 }],
      ['maxAttempts of zero', { ...every, jobOptions: { maxAttempts: 0 } }],
    ];
    for (const [label, body] of cases) {
      const answer = await api.call('POST', '/crons', body);
      expect(answer.status, label).toBe(400);
    }
    expect((await crons()).total).toBe(0);
  });

  test('the template maps maxAttempts to the store attempts and back', async () => {
    const jobOptions = {
      maxAttempts: 4,
      backoff: { type: 'exponential', delay: 500, maxDelay: 8_000 },
      timeout: 30_000,
      removeOnComplete: true,
    };
    const created = await api.call('POST', '/crons', { ...every, jobOptions });
    expect(created.body.cron.jobOptions).toEqual(jobOptions);
    const stored = await f.store.crons.get('tick');
    expect(stored?.jobOptions).toMatchObject({ attempts: 4, timeout: 30_000 });
    const read = await api.call('GET', '/crons/tick');
    expect(read.body.cron.jobOptions).toEqual(jobOptions);
  });

  test('data is stored but not returned', async () => {
    const created = await api.call('POST', '/crons', { ...every, data: { big: 'x'.repeat(50) } });
    expect(created.body.cron).not.toHaveProperty('data');
    expect((await f.store.crons.get('tick'))?.data).toEqual({ big: 'x'.repeat(50) });
    expect((await crons()).crons[0]).not.toHaveProperty('data');
  });

  test('saving again answers 200, keeps executions and an unchanged timing keeps nextRun', async () => {
    await api.call('POST', '/crons', every);
    f.t.clock.advance(60_000);
    expect(await f.store.crons.claimDue()).toMatchObject({ fired: 1 });
    const fired = (await api.call('GET', '/crons/tick')).body.cron;
    expect(fired.executions).toBe(1);
    f.t.clock.advance(10_000);
    const again = await api.call('POST', '/crons', { ...every, priority: 5 });
    expect(again.status).toBe(200);
    expect(again.body.cron).toMatchObject({
      executions: 1,
      priority: 5,
      nextRun: fired.nextRun,
    });
  });

  test('changed timing recomputes nextRun from now and still keeps executions', async () => {
    await api.call('POST', '/crons', every);
    f.t.clock.advance(60_000);
    await f.store.crons.claimDue();
    f.t.clock.advance(1_000);
    const changed = await api.call('PUT', '/crons/tick', { ...every, repeatEvery: 120_000 });
    expect(changed.status).toBe(200);
    expect(changed.body.cron.executions).toBe(1);
    expect(changed.body.cron.nextRun).toBe(START + 61_000 + 120_000);
  });

  test('a cron at its limit reads as exhausted', async () => {
    await api.call('POST', '/crons', { ...every, maxLimit: 1 });
    f.t.clock.advance(60_000);
    await f.store.crons.claimDue();
    const cron = (await api.call('GET', '/crons/tick')).body.cron;
    expect(cron).toMatchObject({ executions: 1, maxLimit: 1, exhausted: true });
  });

  test('PUT takes the name from the path and refuses a body that names another', async () => {
    const created = await api.call('PUT', '/crons/nightly', { queue: 'q', schedule: '0 2 * * *' });
    expect(created).toMatchObject({ status: 200, body: { cron: { name: 'nightly' } } });
    const same = await api.call('PUT', '/crons/nightly', {
      name: 'nightly',
      queue: 'q',
      schedule: '0 3 * * *',
    });
    expect(same.status).toBe(200);
    const other = await api.call('PUT', '/crons/nightly', { ...every, name: 'weekly' });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('invalid_request');
    expect((await api.call('GET', '/crons/weekly')).status).toBe(404);
  });

  test('lists crons by name with the total', async () => {
    for (const name of ['c', 'a', 'b']) {
      await api.call('POST', '/crons', { ...every, name });
    }
    const list = await crons();
    expect(list).toMatchObject({ ok: true, total: 3, truncated: false });
    expect(list.crons.map((cron: { name: string }) => cron.name)).toEqual(['a', 'b', 'c']);
  });

  test('reading or deleting a cron that is not there is 404 cron_not_found', async () => {
    const read = await api.call('GET', '/crons/missing');
    expect(read).toMatchObject({ status: 404, body: { error: { code: 'cron_not_found' } } });
    const del = await api.call('DELETE', '/crons/missing');
    expect(del).toMatchObject({ status: 404, body: { error: { code: 'cron_not_found' } } });
  });

  test('deleting stops the cron and leaves the jobs it created', async () => {
    await api.call('POST', '/crons', every);
    f.t.clock.advance(60_000);
    await f.store.crons.claimDue();
    expect((await api.call('DELETE', '/crons/tick')).body).toEqual({ ok: true });
    expect((await api.call('GET', '/crons/tick')).status).toBe(404);
    f.t.clock.advance(120_000);
    expect(await f.store.crons.claimDue()).toMatchObject({ fired: 0 });
    expect((await api.call('GET', '/queues/q/counts')).body.counts.waiting).toBe(1);
  });

  test('a viewer reads crons and cannot create, replace or delete one', async () => {
    await api.call('POST', '/crons', every);
    expect((await api.asViewer('GET', '/crons')).status).toBe(200);
    expect((await api.asViewer('GET', '/crons/tick')).status).toBe(200);
    expect((await api.asViewer('POST', '/crons', { ...every, name: 'v' })).status).toBe(403);
    expect((await api.asViewer('PUT', '/crons/tick', every)).status).toBe(403);
    expect((await api.asViewer('DELETE', '/crons/tick')).status).toBe(403);
    expect((await crons()).total).toBe(1);
  });
});
