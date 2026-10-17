import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { SCHEDULED_INTERVAL_MS, settingsFromEnv, tickOptionsFromEnv } from '../src/env';

const URL = 'postgres://qcloud:hunter2@db.internal:5432/qcloud';

describe('tickOptionsFromEnv', () => {
  test('defaults to the scheduler period, not the in-process loop period', () => {
    expect(tickOptionsFromEnv({})).toEqual({ intervalMs: SCHEDULED_INTERVAL_MS });
    expect(SCHEDULED_INTERVAL_MS).toBe(60_000);
  });

  test('reads every numeric variable into its option', () => {
    expect(
      tickOptionsFromEnv({
        QCLOUD_TICK_INTERVAL_MS: '30000',
        QCLOUD_TICK_RE_RING_AFTER_MS: '20000',
        QCLOUD_TICK_RING_GRACE_MS: '1500',
        QCLOUD_TICK_WORST_LATENESS_MS: '900',
        QCLOUD_TICK_RING_WINDOW_MS: '600000',
        QCLOUD_TICK_MAX_RINGS_PER_QUEUE: '50',
        QCLOUD_TICK_MAX_ITEMS: '75',
        QCLOUD_TICK_MAX_PASS_MS: '4000',
        QCLOUD_TICK_MAX_RUN_MS: '25000',
      })
    ).toEqual({
      intervalMs: 30_000,
      reRingAfterMs: 20_000,
      ringGraceMs: 1_500,
      worstLatenessMs: 900,
      ringWindowMs: 600_000,
      maxRingsPerQueue: 50,
      maxItems: 75,
      maxPassMs: 4_000,
      maxRunMs: 25_000,
    });
  });

  test('treats an empty variable as unset', () => {
    expect(tickOptionsFromEnv({ QCLOUD_TICK_INTERVAL_MS: '' })).toEqual({
      intervalMs: SCHEDULED_INTERVAL_MS,
    });
  });

  test.each(['5s', '-1', '1.5', '1e3', ' 5', '0x10', 'NaN', '99999999999999999999'])(
    'rejects %j and names the variable',
    (raw) => {
      const attempt = () => tickOptionsFromEnv({ QCLOUD_TICK_MAX_ITEMS: raw });
      expect(attempt).toThrow(UnsupportedOptionError);
      expect(attempt).toThrow(/QCLOUD_TICK_MAX_ITEMS/);
    }
  );
});

describe('settingsFromEnv', () => {
  test('needs the database URL, and names the variable without a value', () => {
    expect(() => settingsFromEnv({})).toThrow(/QCLOUD_DATABASE_URL/);
    expect(() => settingsFromEnv({ QCLOUD_DATABASE_URL: '' })).toThrow(UnsupportedOptionError);
  });

  test('defaults: the default namespace, Pub/Sub, no pooler, the process name', () => {
    expect(settingsFromEnv({ QCLOUD_DATABASE_URL: URL })).toMatchObject({
      namespace: 'default',
      transport: 'gcp-pubsub',
      projectId: undefined,
      database: { url: URL, pooler: 'none', applicationName: 'qcloud-tick' },
      tick: { intervalMs: SCHEDULED_INTERVAL_MS },
    });
  });

  test('reads the namespace, transport, project, pooler and listen URL', () => {
    const settings = settingsFromEnv({
      QCLOUD_DATABASE_URL: URL,
      QCLOUD_NAMESPACE: 'prod',
      QCLOUD_TRANSPORT: 'postgres',
      QCLOUD_GCP_PROJECT: 'my-project',
      QCLOUD_DATABASE_POOLER: 'transaction',
      QCLOUD_DATABASE_LISTEN_URL: 'postgres://direct.internal/qcloud',
    });
    expect(settings).toMatchObject({
      namespace: 'prod',
      transport: 'postgres',
      projectId: 'my-project',
      database: { pooler: 'transaction', listenUrl: 'postgres://direct.internal/qcloud' },
    });
  });

  test('aws-sqs needs an explicit region, and takes an emulator endpoint', () => {
    const env = { QCLOUD_DATABASE_URL: URL, QCLOUD_TRANSPORT: 'aws-sqs' };
    // The region is never read from the machine: AWS_REGION alone is not enough.
    expect(() => settingsFromEnv({ ...env, AWS_REGION: 'eu-west-1' })).toThrow(
      UnsupportedOptionError
    );
    expect(() => settingsFromEnv(env)).toThrow(/QCLOUD_AWS_REGION/);
    expect(
      settingsFromEnv({
        ...env,
        QCLOUD_AWS_REGION: 'eu-west-1',
        QCLOUD_AWS_SQS_ENDPOINT: 'http://127.0.0.1:59324',
      })
    ).toMatchObject({
      transport: 'aws-sqs',
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:59324',
    });
    expect(settingsFromEnv({ ...env, QCLOUD_AWS_REGION: 'eu-west-1' }).endpoint).toBeUndefined();
  });

  test('QCLOUD_DATABASE_POOL_SIZE is the per-process pool: the number the infrastructure budgets', () => {
    expect(settingsFromEnv({ QCLOUD_DATABASE_URL: URL }).database.poolSize).toBeUndefined();
    expect(
      settingsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_POOL_SIZE: '3' }).database
        .poolSize
    ).toBe(3);
    expect(
      settingsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_POOL_SIZE: '' }).database.poolSize
    ).toBeUndefined();
  });

  test.each(['0', '-1', '1.5', 'two', '2 ', '1e1'])(
    'rejects QCLOUD_DATABASE_POOL_SIZE=%p and names the variable',
    (value) => {
      const attempt = () =>
        settingsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_POOL_SIZE: value });
      expect(attempt).toThrow(UnsupportedOptionError);
      expect(attempt).toThrow(/QCLOUD_DATABASE_POOL_SIZE/);
    }
  );

  test.each([
    ['QCLOUD_DATABASE_POOLER', 'session'],
    ['QCLOUD_DATABASE_TLS', 'strict'],
    ['QCLOUD_TRANSPORT', 'sqs'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    const attempt = () => settingsFromEnv({ QCLOUD_DATABASE_URL: URL, [name]: value });
    expect(attempt).toThrow(UnsupportedOptionError);
    expect(attempt).toThrow(new RegExp(name));
  });

  test('a TLS mode and a CA file together are a conflict', () => {
    expect(() =>
      settingsFromEnv({
        QCLOUD_DATABASE_URL: URL,
        QCLOUD_DATABASE_TLS: 'unverified',
        QCLOUD_DATABASE_TLS_CA_FILE: '/etc/ca.pem',
      })
    ).toThrow(/QCLOUD_DATABASE_TLS_CA_FILE/);
  });

  test('the TLS modes map to the driver options', () => {
    const tls = (mode: string) =>
      settingsFromEnv({ QCLOUD_DATABASE_URL: URL, QCLOUD_DATABASE_TLS: mode }).database.tls;
    expect(tls('unverified')).toBe('unverified');
    expect(tls('off')).toBe(false);
    expect(settingsFromEnv({ QCLOUD_DATABASE_URL: URL }).database.tls).toBeUndefined();
  });

  test('no error repeats the database URL or its password', () => {
    for (const env of [
      { QCLOUD_DATABASE_POOLER: 'session' },
      { QCLOUD_DATABASE_TLS: 'strict' },
      { QCLOUD_TRANSPORT: 'sqs' },
      { QCLOUD_TICK_MAX_ITEMS: 'x' },
    ]) {
      try {
        settingsFromEnv({ QCLOUD_DATABASE_URL: URL, ...env });
        throw new Error('expected a rejection');
      } catch (error) {
        const text = String((error as Error).message);
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain(URL);
      }
    }
  });
});
