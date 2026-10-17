import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { databaseOptionsFromEnv } from '../src';

const URL = 'postgres://qcloud:hunter2@db.internal:5432/qcloud';
const AS = { applicationName: 'qcloud-test', purpose: 'the database under test' };

const refused = (env: Record<string, string>) => {
  try {
    databaseOptionsFromEnv(env, AS);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as Error).message).not.toContain('hunter2');
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('databaseOptionsFromEnv', () => {
  test('the URL is required, and the process says what it needs it for', () => {
    expect(refused({})).toMatch(/QCLOUD_DATABASE_URL.*is required: the database under test/);
    expect(refused({ QCLOUD_DATABASE_URL: '' })).toMatch(/QCLOUD_DATABASE_URL/);
  });

  test('defaults: no pooler, the driver default pool, no TLS choice', () => {
    expect(databaseOptionsFromEnv({ QCLOUD_DATABASE_URL: URL }, AS)).toEqual({
      url: URL,
      pooler: 'none',
      applicationName: 'qcloud-test',
    });
  });

  test('reads the pooler, pool size, TLS mode and listen URL', () => {
    expect(
      databaseOptionsFromEnv(
        {
          QCLOUD_DATABASE_URL: URL,
          QCLOUD_DATABASE_POOLER: 'transaction',
          QCLOUD_DATABASE_POOL_SIZE: '4',
          QCLOUD_DATABASE_SCHEMA: 'qcloud_prod',
          QCLOUD_DATABASE_TLS: 'unverified',
          QCLOUD_DATABASE_LISTEN_URL: 'postgres://direct.internal/qcloud',
        },
        AS
      )
    ).toMatchObject({
      pooler: 'transaction',
      poolSize: 4,
      schema: 'qcloud_prod',
      tls: 'unverified',
      listenUrl: 'postgres://direct.internal/qcloud',
    });
    expect(
      databaseOptionsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS: 'off' }, AS).tls
    ).toBe(false);
  });

  test('reads a CA file, and refuses it together with a TLS mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qcloud-ca-'));
    const file = join(dir, 'ca.pem');
    writeFileSync(file, 'PEM');
    expect(
      databaseOptionsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS_CA_FILE: file }, AS)
        .tls
    ).toEqual({ ca: 'PEM' });
    expect(
      refused({
        QCLOUD_DATABASE_URL: URL,
        QCLOUD_DATABASE_TLS: 'off',
        QCLOUD_DATABASE_TLS_CA_FILE: file,
      })
    ).toMatch(/conflicts/);
  });

  test('reads an inline CA bundle, and refuses it with a TLS mode or a CA file', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nhunter3\n-----END CERTIFICATE-----\n';
    expect(
      databaseOptionsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS_CA: pem }, AS).tls
    ).toEqual({ ca: pem });
    const others: Record<string, string>[] = [
      { QCLOUD_DATABASE_TLS: 'unverified' },
      { QCLOUD_DATABASE_TLS_CA_FILE: '/nonexistent/ca.pem' },
    ];
    for (const other of others) {
      const message = refused({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS_CA: pem, ...other });
      expect(message).toMatch(/QCLOUD_DATABASE_TLS_CA.*conflicts/);
      expect(message).not.toContain('hunter3');
    }
  });

  test('an empty inline CA is a mistake, not a request for no TLS', () => {
    expect(refused({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS_CA: '' })).toMatch(
      /QCLOUD_DATABASE_TLS_CA.*empty/
    );
  });

  test.each([
    ['QCLOUD_DATABASE_POOLER', 'session'],
    ['QCLOUD_DATABASE_TLS', 'strict'],
    ['QCLOUD_DATABASE_POOL_SIZE', '0'],
    ['QCLOUD_DATABASE_POOL_SIZE', '2.5'],
    ['QCLOUD_DATABASE_POOL_SIZE', 'many'],
  ])('refuses %s=%j and names the variable', (name, value) => {
    expect(refused({ QCLOUD_DATABASE_URL: URL, [name]: value })).toContain(name);
  });
});
