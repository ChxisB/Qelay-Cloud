import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { StoreError } from '@qelay-cloud/core';
import { ManualClock } from '../../../test/support/clock';
import { describeDb } from '../../../test/support/db';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import type { ReadinessResponse } from '../src';
import { postgresReadiness, TransportReachability } from '../src';
import { healthRoutes } from '../src/routes/health';
import { bodyOf, fakeReadiness, harness } from './support';

const ready = (api: ReturnType<typeof harness>, path = '/health/ready') => api.call('GET', path);

describe('GET /health', () => {
  test('is public, answers from memory and touches no probe', async () => {
    let probed = 0;
    const api = harness(
      {},
      {
        readiness: fakeReadiness({
          database: async () => {
            probed += 1;
          },
          tick: async () => {
            probed += 1;
            return null;
          },
        }),
      }
    );
    const response = await api.call('GET', '/health', { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: 'healthy',
      version: '0.0.0-test',
      uptime: 0,
    });
    expect(probed).toBe(0);
  });
});

describe('GET /health uptime', () => {
  test('counts whole seconds from when the service was built', async () => {
    const api = harness();
    api.clock.advance(125_900);
    const body = await bodyOf(await api.call('GET', '/health', { token: null }));
    expect(body.uptime).toBe(125);
  });
});

describe('GET /health/ready and GET /ready', () => {
  test('both need a token', async () => {
    const api = harness();
    for (const path of ['/health/ready', '/ready']) {
      expect((await api.call('GET', path, { token: null })).status).toBe(401);
    }
  });

  test('ready when the database answers, with the tick and transport reported', async () => {
    const clock = new ManualClock();
    const api = harness(
      {},
      {
        readiness: fakeReadiness({
          transport: () => 'ok',
          tick: async () => ({
            lastSuccessAt: clock.now() - 4_000,
            lastFailureAt: clock.now() - 90_000,
            now: clock.now(),
          }),
        }),
      },
      clock
    );
    for (const path of ['/health/ready', '/ready']) {
      const response = await ready(api, path);
      expect(response.status).toBe(200);
      expect(await bodyOf<ReadinessResponse>(response)).toEqual({
        ok: true,
        ready: true,
        checks: {
          database: { state: 'ok' },
          transport: { state: 'ok' },
          tick: {
            lastSuccessAt: clock.now() - 4_000,
            lastFailureAt: clock.now() - 90_000,
            ageMs: 4_000,
          },
        },
        timestamp: clock.now(),
      });
    }
  });

  test('a database that fails makes the service not ready (503) and still answers the rest', async () => {
    const api = harness(
      {},
      {
        readiness: fakeReadiness({
          database: async () => {
            throw new StoreError('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
          },
        }),
      }
    );
    const response = await ready(api);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('10.1.2.3');
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      ready: false,
      checks: { database: { state: 'failed' } },
    });
  });

  test('a not-ready body carries the storage block the panel reads, and a ready one does not', async () => {
    const down = harness(
      {},
      {
        readiness: fakeReadiness({
          database: async () => {
            throw new Error('down');
          },
        }),
      }
    );
    const body = await bodyOf<ReadinessResponse>(await ready(down));
    expect(body.storage).toEqual({
      diskFull: false,
      error: 'the database is unavailable',
      since: null,
    });
    expect((await bodyOf<ReadinessResponse>(await ready(harness()))).storage).toBeUndefined();
  });

  test('a database that hangs is a failure at the deadline, not a hung probe', async () => {
    const [, , route] = healthRoutes(
      '1',
      fakeReadiness({ database: () => new Promise(() => {}) }),
      new ManualClock(),
      20
    );
    const started = performance.now();
    const response = (await route!.handle({} as never)) as Response;
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an unreadable tick is reported as nulls and does not make the service unready', async () => {
    for (const tick of [async () => null, async () => Promise.reject(new Error('x'))]) {
      const response = await ready(harness({}, { readiness: fakeReadiness({ tick }) }));
      expect(response.status).toBe(200);
      expect((await bodyOf<ReadinessResponse>(response)).checks.tick).toEqual({
        lastSuccessAt: null,
        lastFailureAt: null,
        ageMs: null,
      });
    }
  });

  test('a tick that never succeeded has no age', async () => {
    const api = harness(
      {},
      {
        readiness: fakeReadiness({
          tick: async () => ({ lastSuccessAt: null, lastFailureAt: 5, now: 10 }),
        }),
      }
    );
    expect((await bodyOf<ReadinessResponse>(await ready(api))).checks.tick).toEqual({
      lastSuccessAt: null,
      lastFailureAt: 5,
      ageMs: null,
    });
  });

  test('an unknown or failed transport is reported and does not make the service unready', async () => {
    for (const state of ['unknown', 'failed'] as const) {
      const response = await ready(
        harness({}, { readiness: fakeReadiness({ transport: () => state }) })
      );
      expect(response.status).toBe(200);
      expect((await bodyOf<ReadinessResponse>(response)).checks.transport.state).toBe(state);
    }
  });

  test('carries no job data: only the documented keys', async () => {
    const body = await bodyOf(await ready(harness()));
    expect(Object.keys(body).sort()).toEqual(['checks', 'ok', 'ready', 'timestamp']);
    expect(Object.keys((body as { checks: object }).checks).sort()).toEqual([
      'database',
      'tick',
      'transport',
    ]);
  });
});

describe('TransportReachability', () => {
  test('is unknown until a ring is seen, follows the last one, and goes stale', () => {
    const clock = new ManualClock();
    const reach = new TransportReachability(clock, 60_000);
    expect(reach.state()).toBe('unknown');
    reach.record(true);
    expect(reach.state()).toBe('ok');
    reach.record(false);
    expect(reach.state()).toBe('failed');
    clock.advance(60_001);
    expect(reach.state()).toBe('unknown');
    reach.record(true);
    expect(reach.state()).toBe('ok');
  });
});

describeDb('postgresReadiness against Postgres', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(() => t.drop());

  test('the database probe resolves, and the tick probe reads the tick row on the database clock', async () => {
    const reach = new TransportReachability(t.clock);
    const probes = postgresReadiness(t.fresh.db, t.store, reach);
    await expect(probes.database()).resolves.toBeUndefined();
    expect(await probes.tick()).toMatchObject({ lastSuccessAt: null, lastFailureAt: null });
    await t.store.maintenance.recordTick(true);
    const snapshot = await probes.tick();
    expect(snapshot?.lastSuccessAt).toBeNumber();
    expect(snapshot?.now).toBeGreaterThanOrEqual(snapshot?.lastSuccessAt as number);
    expect(probes.transport()).toBe('unknown');
    reach.record(true);
    expect(probes.transport()).toBe('ok');
  });

  test('the whole route answers ready from a real database', async () => {
    const probes = postgresReadiness(t.fresh.db, t.store, new TransportReachability(t.clock));
    const response = await ready(harness({}, { readiness: probes }, t.clock));
    expect(response.status).toBe(200);
    expect((await bodyOf<ReadinessResponse>(response)).checks.database.state).toBe('ok');
  });

  test('a store whose database fails is a failed probe, and an unreadable tick is null', async () => {
    const broken = {
      run: async () => {
        throw new Error('connection terminated');
      },
    };
    const store = {
      maintenance: {
        tickStatus: async () => {
          throw new Error('connection terminated');
        },
      },
    };
    const probes = postgresReadiness(
      broken as never,
      store as never,
      new TransportReachability(t.clock)
    );
    await expect(probes.database()).rejects.toThrow();
    expect(await probes.tick()).toBeNull();
  });
});
