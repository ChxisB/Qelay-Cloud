import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { databaseOptionsForNamespace, SHARD_SECRET_VARIABLE, ShardMap } from '../src';

const purpose = { applicationName: 'test', purpose: 'the database to use' };
const A = 'postgres://u:pa@127.0.0.1:5432/a';
const B = 'postgres://u:pb@127.0.0.1:5432/b';
const env = {
  QCLOUD_SHARDS: 'acme=a, globex=b,initech=a',
  QCLOUD_SHARD_A_DATABASE_URL: A,
  QCLOUD_SHARD_B_DATABASE_URL: B,
  QCLOUD_SHARD_B_DATABASE_POOL_SIZE: '5',
  QCLOUD_DATABASE_POOL_SIZE: '3',
};

const refused = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    return (error as Error).message;
  }
  throw new Error('expected an UnsupportedOptionError');
};

describe('shard map', () => {
  test("a namespace resolves to its shard, with the shard's own settings over the shared ones", () => {
    expect(databaseOptionsForNamespace(env, 'acme', purpose)).toMatchObject({
      url: A,
      poolSize: 3,
    });
    expect(databaseOptionsForNamespace(env, 'globex', purpose)).toMatchObject({
      url: B,
      poolSize: 5,
    });
    const map = ShardMap.fromEnv(env, purpose)!;
    expect(map.shards).toEqual(['a', 'b']);
    expect(map.namespacesOf('a')).toEqual(['acme', 'initech']);
  });

  test('without QCLOUD_SHARDS it is the one database; a namespace outside the map is refused', () => {
    const one = { QCLOUD_DATABASE_URL: A };
    expect(ShardMap.fromEnv(one, purpose)).toBeNull();
    expect(databaseOptionsForNamespace(one, 'anything', purpose)).toMatchObject({ url: A });
    expect(refused(() => databaseOptionsForNamespace(env, 'default', purpose))).toContain(
      'not in the shard map'
    );
  });

  test('a shard reads only its own credentials, and the shared URL is refused beside a map', () => {
    const onlyA = { QCLOUD_SHARDS: 'acme=a,globex=b', QCLOUD_SHARD_A_DATABASE_URL: A };
    expect(databaseOptionsForNamespace(onlyA, 'acme', purpose)).toMatchObject({ url: A });
    expect(refused(() => databaseOptionsForNamespace(onlyA, 'globex', purpose))).toContain(
      'QCLOUD_SHARD_B_DATABASE_URL'
    );
    expect(refused(() => ShardMap.fromEnv({ ...env, QCLOUD_DATABASE_URL: A }, purpose))).toContain(
      'conflicts'
    );
  });

  test('a malformed map is refused and never repeats a URL', () => {
    for (const bad of ['acme', 'acme=', 'acme=a=b', 'acme=A', 'acme=a,acme=b']) {
      expect(
        refused(() => ShardMap.fromEnv({ ...env, QCLOUD_SHARDS: bad }, purpose))
      ).not.toContain('postgres://');
    }
  });

  test('ShardMap.of checks that every namespace has a database', () => {
    const map = ShardMap.of({ namespaces: { acme: 'a' }, shards: { a: { url: A } } });
    expect(map.databaseFor('acme')).toMatchObject({ url: A });
    expect(
      refused(() => ShardMap.of({ namespaces: { acme: 'b' }, shards: { a: { url: A } } }))
    ).toContain('no database');
  });

  test('the variables that hold a shard URL are the ones a log redacts', () => {
    expect(SHARD_SECRET_VARIABLE.test('QCLOUD_SHARD_A_DATABASE_URL')).toBe(true);
    expect(SHARD_SECRET_VARIABLE.test('QCLOUD_SHARD_B2_DATABASE_LISTEN_URL')).toBe(true);
    expect(SHARD_SECRET_VARIABLE.test('QCLOUD_SHARD_A_DATABASE_POOL_SIZE')).toBe(false);
  });
});
