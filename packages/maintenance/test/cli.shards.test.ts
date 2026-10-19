import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { migrate, openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { TestSchema } from '../../../test/support/db';
import { createTestSchema, describeDb, testDatabaseUrl } from '../../../test/support/db';
import { main } from '../src/cli';
import { settingsFromEnv } from '../src/env';

const A = 'postgres://u:secret-a@127.0.0.1:1/a';
const B = 'postgres://u:secret-b@127.0.0.1:1/b';
const ENV = {
  QCLOUD_SHARDS: 'acme=a,globex=b,initech=a',
  QCLOUD_SHARD_A_DATABASE_URL: A,
  QCLOUD_SHARD_B_DATABASE_URL: B,
  QCLOUD_TICK_INTERVAL_MS: '100',
};
const quiet = { out: () => {}, err: () => {} };

describe('qcloud-tick over shards: settings', () => {
  test("QCLOUD_SHARD is every namespace of that shard, on that shard's database", () => {
    const settings = settingsFromEnv({ ...ENV, QCLOUD_SHARD: 'a' });
    expect(settings.shard).toEqual(['acme', 'initech']);
    expect(settings.database.url).toBe(A);
    const one = settingsFromEnv({ ...ENV, QCLOUD_NAMESPACE: 'globex' });
    expect([one.namespace, one.shard, one.database.url]).toEqual(['globex', undefined, B]);
  });

  test('it needs a map, excludes QCLOUD_NAMESPACE, and names a shard that holds something', () => {
    for (const env of [
      { QCLOUD_DATABASE_URL: A, QCLOUD_SHARD: 'a' },
      { ...ENV, QCLOUD_SHARD: 'a', QCLOUD_NAMESPACE: 'acme' },
      { ...ENV, QCLOUD_SHARD: 'c', QCLOUD_SHARD_C_DATABASE_URL: A },
    ]) {
      expect(() => settingsFromEnv(env)).toThrow(UnsupportedOptionError);
    }
  });

  test('run, serve and send refuse QCLOUD_SHARD rather than tick one namespace of many', async () => {
    for (const command of ['run', 'serve', 'send']) {
      expect(await main([command], { ...ENV, QCLOUD_SHARD: 'a' }, quiet)).toBe(2);
    }
  });
});

describe('qcloud-tick loop over a shard', () => {
  test('one loop for each namespace of the shard, over one pool, and none for another shard', async () => {
    const opened: Array<{ namespace: string; db: unknown }> = [];
    const leased: string[] = [];
    let closed = 0;
    const open = (settings: { namespace: string }, db?: unknown) => {
      opened.push({ namespace: settings.namespace, db });
      const store = {
        ringWindowMs: 0,
        tick: async () => ({
          recovered: 0,
          promoted: 0,
          cronFired: 0,
          expired: 0,
          rings: [],
          moreWork: false,
        }),
        metrics: { totals: async () => ({ completed: 0, failed: 0 }) },
        maintenance: {
          acquireTickLease: async () => (leased.push(settings.namespace), { held: true }),
          recordTick: async () => {},
          releaseTickLease: async () => void leased.push(`release ${settings.namespace}`),
        },
        close: async () => void (closed += 1),
      };
      return { store, transport: new MemoryTransport() } as never;
    };
    const stop = new AbortController();
    const err: string[] = [];
    const done = main(
      ['loop'],
      { ...ENV, QCLOUD_SHARD: 'a' },
      { out: () => {}, err: (l) => void err.push(l) },
      {
        open,
        stopSignal: stop.signal,
      }
    );
    await Bun.sleep(350);
    stop.abort();
    expect(await done).toBe(0);
    expect(opened.map((o) => o.namespace)).toEqual(['acme', 'initech']);
    expect(opened[0]!.db).toBeDefined();
    expect(opened[0]!.db).toBe(opened[1]!.db);
    expect(new Set(leased)).toEqual(
      new Set(['acme', 'initech', 'release acme', 'release initech'])
    );
    expect(closed).toBe(0);
    expect(err.join('\n')).toContain('"namespaces":2');
    expect(err.join('\n')).not.toContain('secret');
  });
});

describeDb('qcloud-tick loop over shards on a database', () => {
  // Two schemas stand in for two databases. Shard a holds acme and initech, shard b holds globex.
  let a: TestSchema;
  let b: TestSchema;
  const on = (schema: TestSchema) =>
    openDatabase({ url: testDatabaseUrl(), schema: schema.name, poolSize: 2 });
  beforeAll(async () => {
    [a, b] = await Promise.all([createTestSchema(), createTestSchema()]);
    for (const schema of [a, b]) {
      const db = on(schema);
      await migrate(db);
      await db.close();
    }
  });
  afterAll(() => Promise.all([a.drop(), b.drop()]));

  test('delayed jobs of both namespaces of the shard come due, and the other shard is left alone', async () => {
    const delayed = async (schema: TestSchema, namespace: string) => {
      const store = new PostgresStore({ db: on(schema), namespace });
      await store.enqueue([{ queue: 'q', data: 1, options: { delay: 200 } }]);
      await store.close();
    };
    await Promise.all([delayed(a, 'acme'), delayed(a, 'initech'), delayed(b, 'globex')]);
    const env = {
      QCLOUD_SHARDS: ENV.QCLOUD_SHARDS,
      QCLOUD_SHARD: 'a',
      QCLOUD_TRANSPORT: 'postgres',
      QCLOUD_SHARD_A_DATABASE_URL: testDatabaseUrl(),
      QCLOUD_SHARD_A_DATABASE_SCHEMA: a.name,
      QCLOUD_TICK_INTERVAL_MS: '100',
    };
    const stop = new AbortController();
    const done = main(['loop'], env, quiet, { stopSignal: stop.signal });
    await Bun.sleep(1_500);
    stop.abort();
    expect(await done).toBe(0);
    const states = async (schema: TestSchema) =>
      await schema.sql`SELECT namespace, state FROM qcloud_jobs ORDER BY namespace`;
    expect(await states(a)).toEqual([
      { namespace: 'acme', state: 'waiting' },
      { namespace: 'initech', state: 'waiting' },
    ]);
    expect(await states(b)).toEqual([{ namespace: 'globex', state: 'delayed' }]);
  });
});
