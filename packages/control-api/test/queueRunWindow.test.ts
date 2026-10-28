import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('queue run window routes', () => {
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

  // The test clock reads 08:00 UTC: this window opened at 03:00 and closed at 04:00, and opens again at 03:00 tomorrow.
  const CLOSED = { cron: '0 3 * * *', durationMs: 3_600_000, timezone: 'UTC' };
  // Opened at 07:00 and open until 09:00.
  const OPEN = { cron: '0 7 * * *', durationMs: 7_200_000, timezone: 'UTC' };
  const HOUR = 3_600_000;

  test('a queue with no window says null; a saved one is read back with where it stands; another queue has none', async () => {
    expect((await api.call('GET', '/queues/q/run-window')).body).toEqual({
      ok: true,
      runWindow: null,
    });
    const saved = await api.call('PUT', '/queues/q/run-window', CLOSED);
    const now = f.t.clock.now();
    expect(saved).toMatchObject({ status: 200, body: { ok: true, runWindow: CLOSED } });
    expect(saved.body.runWindow).toMatchObject({
      open: false,
      opensAt: now + 19 * HOUR,
      closesAt: now + 20 * HOUR,
    });
    expect((await api.call('GET', '/queues/q/run-window')).body.runWindow).toEqual(
      saved.body.runWindow
    );
    expect((await api.call('GET', '/queues/other/run-window')).body.runWindow).toBeNull();
  });

  test('the zone defaults to UTC', async () => {
    const saved = await api.call('PUT', '/queues/q/run-window', {
      cron: '0 7 * * *',
      durationMs: 2 * HOUR,
    });
    expect(saved.body.runWindow).toMatchObject({ timezone: 'UTC', open: true });
  });

  test('a closed queue holds its job and an open one lets it run', async () => {
    await api.call('PUT', '/queues/q/run-window', CLOSED);
    await f.store.enqueue([{ queue: 'q', data: 1 }]);
    expect(await f.store.claim('q', 'w', 1)).toEqual([]);
    await api.call('PUT', '/queues/q/run-window', OPEN);
    expect(await f.store.claim('q', 'w', 1)).toHaveLength(1);
  });

  test('DELETE removes the window and the held job runs', async () => {
    await api.call('PUT', '/queues/q/run-window', CLOSED);
    await f.store.enqueue([{ queue: 'q', data: 1 }]);
    const removed = await api.call('DELETE', '/queues/q/run-window');
    expect(removed).toMatchObject({ status: 200, body: { ok: true, runWindow: null } });
    expect((await api.call('GET', '/queues/q/run-window')).body.runWindow).toBeNull();
    expect(await f.store.claim('q', 'w', 1)).toHaveLength(1);
  });

  test('an invalid window is 400 unsupported_option naming the field, and the stored one stays', async () => {
    await api.call('PUT', '/queues/q/run-window', OPEN);
    for (const [body, option] of [
      [{ cron: 'not a cron', durationMs: HOUR }, 'runWindow'],
      [{ cron: '0 7 * * *' }, 'durationMs'],
      [{ cron: '0 7 * * *', durationMs: 1_000 }, 'durationMs'],
      [{ cron: '0 7 * * *', durationMs: 8 * 24 * HOUR }, 'durationMs'],
      [{ cron: '0 7 * * *', durationMs: HOUR, timezone: 'Mars/Base' }, 'runWindow'],
      [{ durationMs: HOUR }, 'runWindow'],
    ] as const) {
      const answer = await api.call('PUT', '/queues/q/run-window', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error).toMatchObject({ code: 'unsupported_option', details: { option } });
    }
    expect((await api.call('GET', '/queues/q/run-window')).body.runWindow).toMatchObject(OPEN);
  });

  test('a body that is not an object is 400', async () => {
    for (const body of [[1], 'nightly', null]) {
      expect((await api.call('PUT', '/queues/q/run-window', body)).status).toBe(400);
    }
  });

  test('a viewer reads the window and cannot change it', async () => {
    expect((await api.asViewer('GET', '/queues/q/run-window')).status).toBe(200);
    expect((await api.asViewer('PUT', '/queues/q/run-window', OPEN)).status).toBe(403);
    expect((await api.asViewer('DELETE', '/queues/q/run-window')).status).toBe(403);
  });

  test('a save and a removal are audited', async () => {
    await api.call('PUT', '/queues/q/run-window', OPEN);
    await api.call('DELETE', '/queues/q/run-window');
    const [removed, saved] = (await f.store.audit.list({ limit: 2 })).items;
    expect(removed).toMatchObject({ action: 'DELETE /queues/:queue/run-window', status: 200 });
    expect(JSON.stringify(removed)).toContain('runWindow removed');
    expect(saved).toMatchObject({ action: 'PUT /queues/:queue/run-window', status: 200 });
    expect(JSON.stringify(saved)).toContain('runWindow 0 7 * * * for 7200000ms');
  });
});
