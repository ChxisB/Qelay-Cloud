import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, expireLease, resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import { sharedSecretAuthenticator } from '../src/auth';
import { createTickHandler, TICK_PATH } from '../src/http';
import type { RunReport } from '../src/tick';
import { RecordingTransport, recordedTelemetry, ticker } from './support';

const SECRET = 'a-development-secret-of-24+';
const URL_BASE = 'http://tick.test';

const call = (
  handler: (request: Request) => Promise<Response>,
  init: { method?: string; path?: string; secret?: string | null } = {}
): Promise<Response> =>
  handler(
    new Request(`${URL_BASE}${init.path ?? TICK_PATH}`, {
      method: init.method ?? 'POST',
      headers: init.secret === null ? {} : { authorization: `Bearer ${init.secret ?? SECRET}` },
    })
  );

const REPORT: RunReport = {
  passes: 1,
  recovered: 2,
  promoted: 3,
  cronFired: 4,
  expired: 5,
  ring: { due: 6, rung: 6, deferred: 0, rejected: 0, unreachable: 0, unmarked: 0, skipped: 0 },
  webhooks: { claimed: 0, delivered: 0, retrying: 0, failed: 0, stale: 0, paused: 0, errors: 0 },
  workflows: { due: 0, recovered: 0, errors: 0 },
  moreWork: false,
  durationMs: 7,
  ok: true,
};

describe('the tick endpoint', () => {
  let runs = 0;
  let outcome: () => Promise<RunReport>;
  const telemetry = recordedTelemetry();
  const handler = createTickHandler({
    authenticate: sharedSecretAuthenticator(SECRET),
    run: () => {
      runs += 1;
      return outcome();
    },
    telemetry,
  });
  beforeEach(() => {
    runs = 0;
    outcome = async () => REPORT;
    telemetry.errors.length = 0;
  });

  test('an authenticated POST runs the tick and returns its report as JSON', async () => {
    const response = await call(handler);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(REPORT);
    expect(runs).toBe(1);
  });

  test.each([
    ['no credentials', null],
    ['a wrong secret', 'a-development-secret-of-24-'],
    ['an empty secret', ''],
  ])('%s: 401, a bearer challenge, and no tick', async (_name, secret) => {
    const response = await call(handler, { secret });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(runs).toBe(0);
  });

  test('authentication comes before the method: a probe with a wrong secret learns nothing else', async () => {
    expect(
      (await call(handler, { method: 'GET', secret: 'wrong-wrong-wrong-wrong-wrong' })).status
    ).toBe(401);
    expect(runs).toBe(0);
  });

  test.each(['GET', 'PUT', 'DELETE', 'PATCH'])(
    '%s with valid credentials: 405, and no tick',
    async (method) => {
      const response = await call(handler, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(runs).toBe(0);
    }
  );

  test.each(['/', '/internal', '/internal/tick/', '/internal/tick/extra', '/tick', '/health'])(
    'path %s: 404 without even looking at credentials, and no tick',
    async (path) => {
      expect((await call(handler, { path, secret: null })).status).toBe(404);
      expect(runs).toBe(0);
    }
  );

  test('a query string does not change the path', async () => {
    const response = await handler(
      new Request(`${URL_BASE}${TICK_PATH}?force=1`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      })
    );
    expect(response.status).toBe(200);
  });

  test('a failing tick is a 500 that says only that it failed, and the cause goes to telemetry', async () => {
    outcome = async () => {
      throw new Error('connect ECONNREFUSED postgres://qcloud:hunter2@db.internal:5432/prod');
    };
    const response = await call(handler);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"tick failed"}');
    expect(text).not.toContain('hunter2');
    expect(telemetry.errors).toHaveLength(1);
    expect(telemetry.errors[0]![0]).toBe('http');
  });

  test('an authenticator that throws is a refusal, not a crash', async () => {
    const broken = createTickHandler({
      authenticate: async () => {
        throw new Error('jwks fetch failed');
      },
      run: async () => {
        runs += 1;
        return REPORT;
      },
      telemetry,
    });
    expect((await call(broken)).status).toBe(401);
    expect(runs).toBe(0);
    expect(telemetry.errors.map(([step]) => step)).toEqual(['http']);
  });

  test('a telemetry sink that throws does not turn a 500 into a crash', async () => {
    outcome = async () => {
      throw new Error('boom');
    };
    const noisy = createTickHandler({
      authenticate: sharedSecretAuthenticator(SECRET),
      run: () => outcome(),
      telemetry: {
        duration() {},
        gauge() {},
        error() {
          throw new Error('sink down');
        },
      },
    });
    expect((await call(noisy)).status).toBe(500);
  });

  test('overlapping calls both run: a tick is safe against itself', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    outcome = async () => {
      await gate;
      return REPORT;
    };
    const both = [call(handler), call(handler)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(2);
    release();
    expect((await Promise.all(both)).map((response) => response.status)).toEqual([200, 200]);
  });
});

describeDb('the tick endpoint over a real store', () => {
  let t: TestStore;
  const transport = new RecordingTransport();
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 3_600_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('the report carries counts and milliseconds, and no name, id, payload or error text', async () => {
    const dead = await claimOne(t, { attempts: 3, backoff: 0 });
    expireLease(t, dead, 1);
    const marker = 'secret-customer-payload';
    const queue = 'billing-eu-west';
    const ids = (
      await t.store.enqueue([1, 2, 3].map((n) => ({ queue, data: { marker, n }, options: {} })))
    ).map((job) => job.id);
    const tick = ticker(t.store, transport, { intervalMs: 5_000, ringGraceMs: 0 });
    const handler = createTickHandler({
      authenticate: sharedSecretAuthenticator(SECRET),
      run: tick.run,
    });

    const response = await call(handler);
    const text = await response.text();
    expect(response.status).toBe(200);
    const report = JSON.parse(text) as RunReport;
    expect(report).toMatchObject({ recovered: 1, ok: true });
    expect(report.ring.rung).toBe(4);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(queue);
    for (const id of [...ids, dead.id]) expect(text).not.toContain(id);
    // Every value is a number, a boolean or a nested count.
    const leaves: unknown[] = [];
    const walk = (value: unknown): void => {
      if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
      else leaves.push(value);
    };
    walk(report);
    expect(leaves.every((leaf) => typeof leaf === 'number' || typeof leaf === 'boolean')).toBe(
      true
    );
  });

  test('a dead broker is a 200 with ok false, so the caller can see the tick ran but did not ring', async () => {
    await enqueueN(t.store, 2);
    const down = new RecordingTransport();
    down.throwNext(5);
    const handler = createTickHandler({
      authenticate: sharedSecretAuthenticator(SECRET),
      run: ticker(t.store, down, { intervalMs: 5_000, ringGraceMs: 0 }).run,
    });
    const response = await call(handler);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, ring: { unreachable: 2 } });
  });
});
