import { afterAll, beforeAll, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { ShardMap } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { Queue } from '../src';
import type { SdkFixture } from './support';
import { openFixture } from './support';

describeDb('queue: shards', () => {
  // Two schemas of the one test database stand in for two databases: a namespace's rows land in one only.
  let a: SdkFixture;
  let b: SdkFixture;
  let shards: ShardMap;
  beforeAll(async () => {
    [a, b] = await Promise.all([openFixture(), openFixture()]);
    const on = (f: SdkFixture) => ({ url: testDatabaseUrl(), schema: f.fresh.name, poolSize: 2 });
    shards = ShardMap.of({
      namespaces: { acme: 'a', globex: 'b' },
      shards: { a: on(a), b: on(b) },
    });
  });
  afterAll(async () => {
    await Promise.all([a.drop(), b.drop()]);
  });

  const jobsIn = async (f: SdkFixture) =>
    (await f.fresh
      .sql`SELECT namespace, count(*)::int AS n FROM qcloud_jobs GROUP BY namespace`) as Array<{
      namespace: string;
      n: number;
    }>;

  test('a queue writes to the database its namespace is on, and to no other', async () => {
    const transport = new MemoryTransport();
    const acme = new Queue('q', { transport, shards, namespace: 'acme' });
    const globex = new Queue('q', { transport, shards, namespace: 'globex' });
    try {
      await acme.add('j', { n: 1 });
      await acme.add('j', { n: 2 });
      await globex.add('j', { n: 3 });
      expect(await jobsIn(a)).toEqual([{ namespace: 'acme', n: 2 }]);
      expect(await jobsIn(b)).toEqual([{ namespace: 'globex', n: 1 }]);
      expect(await acme.getJobCounts()).toMatchObject({ waiting: 2 });
      expect(await globex.getJobCounts()).toMatchObject({ waiting: 1 });
    } finally {
      await Promise.all([acme.close(), globex.close()]);
    }
  });

  test('a namespace outside the map, or a url beside the map, is refused at construction', () => {
    const transport = new MemoryTransport();
    expect(() => new Queue('q', { transport, shards, namespace: 'unknown' })).toThrow(
      /not in the shard map/
    );
    expect(() => new Queue('q', { transport, shards })).toThrow(UnsupportedOptionError);
    expect(
      () =>
        new Queue('q', {
          transport,
          shards,
          namespace: 'acme',
          databaseUrl: 'postgres://x@127.0.0.1/d',
        })
    ).toThrow(/cannot be combined/);
  });
});
