import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { START } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const MINUTE = 60_000;

describeDb('metrics and server status routes', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api({ summaryCacheMs: 0, maxMetricsMinutes: 120 });
  });

  /** Two completed in minute 0, one in minute 1 and one failed in minute 2 (a minute-aligned START). */
  async function finishSome(queue = 'q'): Promise<void> {
    for (let index = 0; index < 2; index += 1) {
      await f.store.complete((await claimOne(f.t, {}, queue, 'w')).lease, index);
    }
    f.t.clock.advance(MINUTE);
    await f.store.complete((await claimOne(f.t, {}, queue, 'w')).lease, 'x');
    f.t.clock.advance(MINUTE);
    const bad = await claimOne(f.t, { attempts: 1 }, queue, 'w');
    await f.store.fail(bad.lease, { message: 'boom', unrecoverable: true });
  }

  test('the counters of the panel are the totals the dashboard reads', async () => {
    await finishSome();
    const answer = await api.call('GET', '/metrics');
    expect(answer.status).toBe(200);
    expect(answer.body.metrics).toMatchObject({ totalCompleted: 3, totalFailed: 1 });
    expect(answer.body.metrics.totalPushed).toBeGreaterThanOrEqual(4);
    expect(answer.body.metrics.totalPulled).toBeGreaterThanOrEqual(4);
  });

  test('a queue series is one dense point per minute, oldest first, with lifetime totals', async () => {
    await finishSome();
    const answer = await api.call('GET', `/metrics/queues/q?minutes=3&until=${START + 2 * MINUTE}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      ok: true,
      queue: 'q',
      minutes: 3,
      resolution: 1,
      points: [
        { timestamp: START, completed: 2, failed: 0 },
        { timestamp: START + MINUTE, completed: 1, failed: 0 },
        { timestamp: START + 2 * MINUTE, completed: 0, failed: 1 },
      ],
      totals: { completed: 3, failed: 1 },
    });
  });

  test('a coarser resolution sums minutes into windows that start on their boundary', async () => {
    await finishSome();
    const answer = await api.call(
      'GET',
      `/metrics/queues/q?minutes=10&resolution=5&until=${START + 2 * MINUTE}`
    );
    expect(answer.body.resolution).toBe(5);
    expect(answer.body.points).toEqual([
      { timestamp: START - 10 * MINUTE, completed: 0, failed: 0 },
      { timestamp: START - 5 * MINUTE, completed: 0, failed: 0 },
      { timestamp: START, completed: 3, failed: 1 },
    ]);
  });

  test('a queue that never ran is a series of zeros and not an error', async () => {
    const answer = await api.call('GET', '/metrics/queues/none?minutes=2');
    expect(answer.status).toBe(200);
    expect(answer.body.points).toHaveLength(2);
    expect(answer.body.points.every((p: { completed: number }) => p.completed === 0)).toBe(true);
    expect(answer.body.totals).toEqual({ completed: 0, failed: 0 });
  });

  test('one queue does not read another queue', async () => {
    await finishSome('a');
    const other = await api.call('GET', '/metrics/queues/b?minutes=5');
    expect(other.body.totals).toEqual({ completed: 0, failed: 0 });
  });

  test('a range, resolution or time the store would not take is 400', async () => {
    const cases: Array<[string, string, string]> = [
      ['no minutes', 'minutes=0', 'invalid_request'],
      ['not a number', 'minutes=abc', 'invalid_request'],
      ['resolution of seven', 'resolution=7', 'invalid_request'],
      ['negative until', 'until=-5', 'invalid_request'],
      ['past the cap', 'minutes=121', 'range_too_large'],
    ];
    for (const [label, query, code] of cases) {
      const answer = await api.call('GET', `/metrics/queues/q?${query}`);
      expect(answer.status, label).toBe(400);
      expect(answer.body.error.code, label).toBe(code);
    }
  });

  test('a viewer reads metrics', async () => {
    expect((await api.asViewer('GET', '/metrics')).status).toBe(200);
    expect((await api.asViewer('GET', '/metrics/queues/q')).status).toBe(200);
  });

  test('ping answers with the service clock and storage reports a disk that is not full', async () => {
    expect((await api.call('GET', '/ping')).body).toEqual({
      ok: true,
      data: { pong: true, time: f.t.clock.now() },
    });
    expect((await api.call('GET', '/storage')).body).toEqual({
      ok: true,
      data: { diskFull: false, error: null, since: null },
    });
  });

  test('the server-process pages are 501 under serverControl, and a refused write is still 403 for a viewer', async () => {
    for (const [method, path] of [
      ['POST', '/gc'],
      ['GET', '/heapstats'],
      ['GET', '/prometheus'],
    ] as const) {
      const answer = await api.call(method, path);
      expect(answer.status, path).toBe(501);
      expect(answer.body.error.code, path).toBe('not_supported');
      expect(answer.body.error.details.capability, path).toBe('serverControl');
    }
    expect((await api.asViewer('POST', '/gc')).status).toBe(403);
  });
});
