import { afterAll, beforeAll, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TestSchema } from '../../../test/support/db';
import { createTestSchema, describeDb, testDatabaseUrl } from '../../../test/support/db';
import { LATEST_VERSION } from '../../store-postgres/src';
import { main, runtimeSettingsFromEnv } from '../src';

const OIDC = {
  QCLOUD_API_OIDC_ISSUER: 'https://accounts.example.com/',
  QCLOUD_API_OIDC_AUDIENCE: 'qelay-control-api',
  QCLOUD_API_OIDC_JWKS_URL: 'https://accounts.example.com/jwks.json',
};
const A = 'postgres://u:secret-a@127.0.0.1:5432/a';
const B = 'postgres://u:secret-b@127.0.0.1:5432/b';

test("an API serves the namespace it is given from that namespace's shard, and holds no other shard's URL", () => {
  const env = {
    ...OIDC,
    QCLOUD_SHARDS: 'acme=a,globex=b',
    QCLOUD_SHARD_A_DATABASE_URL: A,
    QCLOUD_NAMESPACE: 'acme',
  };
  expect(runtimeSettingsFromEnv(env).database.url).toBe(A);
  expect(
    runtimeSettingsFromEnv({ ...env, QCLOUD_SHARD_B_DATABASE_URL: B, QCLOUD_NAMESPACE: 'globex' })
      .database.url
  ).toBe(B);
  expect(() => runtimeSettingsFromEnv({ ...env, QCLOUD_NAMESPACE: 'globex' })).toThrow(
    UnsupportedOptionError
  );
  expect(() => runtimeSettingsFromEnv({ ...env, QCLOUD_NAMESPACE: 'nobody' })).toThrow(
    /not in the shard map/
  );
});

describeDb('qcloud-api migrate over shards', () => {
  let a: TestSchema;
  let b: TestSchema;
  beforeAll(async () => {
    [a, b] = await Promise.all([createTestSchema(), createTestSchema()]);
  });
  afterAll(() => Promise.all([a.drop(), b.drop()]));

  test('it migrates every shard, naming each, and a shard that fails is named', async () => {
    const env = {
      QCLOUD_SHARDS: 'acme=a,globex=b,initech=a',
      QCLOUD_SHARD_A_DATABASE_URL: testDatabaseUrl(),
      QCLOUD_SHARD_A_DATABASE_SCHEMA: a.name,
      QCLOUD_SHARD_B_DATABASE_URL: testDatabaseUrl(),
      QCLOUD_SHARD_B_DATABASE_SCHEMA: b.name,
    };
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    expect(await main(['migrate'], env, io)).toBe(0);
    expect(out.map((line) => JSON.parse(line))).toMatchObject([
      { shard: 'a', to: LATEST_VERSION },
      { shard: 'b', to: LATEST_VERSION },
    ]);
    for (const schema of [a, b]) {
      const [row] =
        await schema.sql`SELECT max(version)::int AS version FROM qcloud_schema_migrations`;
      expect(row.version).toBe(LATEST_VERSION);
    }

    // Shard b ahead of this build: a is already current and prints, b refuses and says so.
    await b.sql`INSERT INTO qcloud_schema_migrations (version, applied_at, checksum) VALUES (${LATEST_VERSION + 1}, 0, 'newer')`;
    out.length = 0;
    expect(await main(['migrate'], env, io)).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(err.join('\n'))).toMatchObject({ msg: 'schema_ahead', shard: 'b' });
    expect(err.join('\n')).not.toContain('secret');
  });
});
