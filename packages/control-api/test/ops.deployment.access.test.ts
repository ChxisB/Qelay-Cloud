import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { LATEST_VERSION } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import { deploymentHarness } from './deploymentHarness';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { SECRETS, strings } from './opsFixture';
import { DEV_TOKEN, fakeReadiness } from './support';

describeDb('GET /deployment: what it leaves out and what it refuses', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());
  const { open, deployment, tickedAgo } = deploymentHarness(() => f);

  test('without the jobs routes the store figures are unknown, not zero', async () => {
    const body = await deployment(open({}, { readiness: tickedAgo(1_000) }, false));
    expect(body.schema).toEqual({ current: null, expected: LATEST_VERSION, state: 'unknown' });
    expect(body.connections).toEqual({
      inUse: null,
      maxConnections: null,
      needed: null,
      mode: null,
    });
    expect(body.workers).toEqual({ total: null, active: null });
    expect(body.doorbells).toEqual({
      notRung: null,
      oldestNotRungAgeMs: null,
      queuesScanned: null,
      partial: false,
    });
    expect(body.tick.state).toBe('ok');
  });

  test('warns that the development token is enabled, and never repeats it', async () => {
    const body = await deployment(open({}, { readiness: tickedAgo(1_000) }));
    expect(body.devToken).toBe(true);
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ code: 'dev_token_enabled', severity: 'warning' })
    );
  });

  test('holds no secret: no token, connection string or password anywhere in the answer', async () => {
    const previous = process.env.QCLOUD_DATABASE_URL;
    process.env.QCLOUD_DATABASE_URL = 'postgres://app:hunter2-secret@db.internal:5432/qelay';
    try {
      const api = open(
        { deployment: { fleet: { workers: 2 }, commit: 'abc123' } },
        {
          readiness: tickedAgo(1_000),
        }
      );
      const body = await deployment(api);
      const seen = strings(body).join('\n').toLowerCase();
      for (const secret of [...SECRETS, 'hunter2', 'db.internal', 'app:']) {
        expect(seen).not.toContain(secret.toLowerCase());
      }
      // The only mention of a token is the boolean that says the development one is on.
      expect(body.devToken).toBe(true);
      expect(Object.keys(body).filter((key) => /secret|password|dsn|url|key/i.test(key))).toEqual(
        []
      );
      expect(DEV_TOKEN.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.QCLOUD_DATABASE_URL;
      else process.env.QCLOUD_DATABASE_URL = previous;
    }
  });

  test('is read by a viewer', async () => {
    const api = open({ devToken: { token: DEV_TOKEN, role: 'viewer' } });
    expect((await api.call('GET', '/deployment')).status).toBe(200);
  });

  test('is served from the cache for its time and read again on bypass', async () => {
    let probes = 0;
    const readiness = fakeReadiness({
      database: async () => {
        probes += 1;
      },
    });
    const api = open({ deployment: { cacheMs: 5_000 } }, { readiness });
    await deployment(api);
    await deployment(api);
    expect(probes).toBe(1);
    await api.call('GET', '/deployment', { headers: { 'x-qelay-cache': 'bypass' } });
    expect(probes).toBe(2);
  });

  describe('describe', () => {
    test('does not change anything: it is a GET and the other methods are refused', async () => {
      const api = open();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect((await api.call(method, '/deployment')).status).toBe(405);
      }
    });
  });
});
