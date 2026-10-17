import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { LATEST_VERSION } from '../../store-postgres/src';
import { PostgresStore } from '../../store-postgres/src';
import { freshSchema } from '../../store-postgres/test/helpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import type { ReadinessResponse } from '../src';
import { postgresReadiness, TransportReachability } from '../src';
import { schemaStateOf } from '../src/routes/health';
import { bodyOf, fakeReadiness, harness } from './support';

const ready = (api: ReturnType<typeof harness>) => api.call('GET', '/health/ready');

describe('schemaStateOf', () => {
  test.each([
    [null, 'unknown'],
    [0, 'behind'],
    [LATEST_VERSION - 1, 'behind'],
    [LATEST_VERSION, 'current'],
    [LATEST_VERSION + 1, 'ahead'],
  ] as const)('version %p against the build is %s', (current, state) => {
    expect(schemaStateOf(current, LATEST_VERSION)).toBe(state);
  });
});

describe('GET /health/ready and the schema', () => {
  const withSchema = (schemaVersion: () => Promise<number | null>) =>
    harness({}, { readiness: fakeReadiness({ schemaVersion }) });

  test('a probe set without a schema probe reports no schema block', async () => {
    const body = await bodyOf<ReadinessResponse>(await ready(harness()));
    expect(body.checks.schema).toBeUndefined();
  });

  test('a database at this build’s version is ready and says so', async () => {
    const response = await ready(withSchema(async () => LATEST_VERSION));
    expect(response.status).toBe(200);
    expect((await bodyOf<ReadinessResponse>(response)).checks.schema).toEqual({
      state: 'current',
      current: LATEST_VERSION,
      expected: LATEST_VERSION,
    });
  });

  test('a database that lacks a migration this build needs is not ready, and the body names the fix', async () => {
    const response = await ready(withSchema(async () => LATEST_VERSION - 1));
    expect(response.status).toBe(503);
    const body = await bodyOf<ReadinessResponse>(response);
    expect(body).toMatchObject({
      ok: false,
      ready: false,
      checks: {
        database: { state: 'ok' },
        schema: { state: 'behind', current: LATEST_VERSION - 1, expected: LATEST_VERSION },
      },
    });
    expect(body.storage?.error).toContain('run the migrations');
  });

  test('a database already migrated by a newer release stays ready: the migrations are forward-only', async () => {
    const response = await ready(withSchema(async () => LATEST_VERSION + 1));
    expect(response.status).toBe(200);
    expect((await bodyOf<ReadinessResponse>(response)).checks.schema?.state).toBe('ahead');
  });

  test('an unreadable schema is unknown and does not by itself make the service unready', async () => {
    const response = await ready(
      withSchema(async () => {
        throw new Error('permission denied for table qcloud_schema_migrations');
      })
    );
    expect(response.status).toBe(200);
    const body = await bodyOf<ReadinessResponse>(response);
    expect(body.checks.schema).toEqual({
      state: 'unknown',
      current: null,
      expected: LATEST_VERSION,
    });
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });
});

describeDb('postgresReadiness and the schema, against Postgres', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(() => t.drop());

  test('a migrated database is current', async () => {
    const probes = postgresReadiness(t.fresh.db, t.store, new TransportReachability(t.clock));
    const response = await ready(harness({}, { readiness: probes }, t.clock));
    expect(response.status).toBe(200);
    expect((await bodyOf<ReadinessResponse>(response)).checks.schema?.state).toBe('current');
  });

  test('a database nothing has migrated is behind, so the service is not ready until the release step runs', async () => {
    const bare = await freshSchema();
    try {
      const store = new PostgresStore({ db: bare.db, namespace: 'test' });
      const probes = postgresReadiness(bare.db, store, new TransportReachability(t.clock));
      const response = await ready(harness({}, { readiness: probes }, t.clock));
      expect(response.status).toBe(503);
      expect((await bodyOf<ReadinessResponse>(response)).checks).toMatchObject({
        database: { state: 'ok' },
        schema: { state: 'behind', current: 0, expected: LATEST_VERSION },
      });
    } finally {
      await bare.drop();
    }
  });
});
