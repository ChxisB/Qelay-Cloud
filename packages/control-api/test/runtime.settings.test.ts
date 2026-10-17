import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import {
  ControlApiConfigError,
  DEFAULT_SHUTDOWN_GRACE_MS,
  MAX_SHUTDOWN_GRACE_MS,
  runtimeSettingsFromEnv,
} from '../src';

const URL = 'postgres://qcloud:hunter2-db-password@db.internal:5432/qcloud';
const TOKEN = 'dev-token-0123456789-abcdefghij';
const OIDC = {
  QCLOUD_API_OIDC_ISSUER: 'https://accounts.example.com/',
  QCLOUD_API_OIDC_AUDIENCE: 'qelay-control-api',
  QCLOUD_API_OIDC_JWKS_URL: 'https://accounts.example.com/jwks.json',
};
const BASE = { QCLOUD_DATABASE_URL: URL, ...OIDC };

const refused = (env: Record<string, string>, type: new (...args: never[]) => Error) => {
  let error: unknown;
  try {
    runtimeSettingsFromEnv(env);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(type);
  const message = (error as Error).message;
  // A refusal names the variable. It never repeats a value that could be a credential.
  for (const secret of [URL, 'hunter2-db-password', TOKEN]) expect(message).not.toContain(secret);
  return message;
};

describe('runtimeSettingsFromEnv', () => {
  test('needs the database URL, and names the variable without a value', () => {
    expect(refused({ ...OIDC }, UnsupportedOptionError)).toMatch(/QCLOUD_DATABASE_URL/);
  });

  test('defaults: the default namespace, Pub/Sub, loopback on 8080, the process name', () => {
    const settings = runtimeSettingsFromEnv(BASE);
    expect(settings).toMatchObject({
      namespace: 'default',
      transport: 'gcp-pubsub',
      projectId: undefined,
      listen: { hostname: '127.0.0.1', port: 8080 },
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      database: { url: URL, pooler: 'none', applicationName: 'qcloud-api' },
    });
    expect(settings.api.production).toBe(false);
    expect(settings.api.deployment).toEqual({});
    expect(settings.jobs).toEqual({});
  });

  test('aws-sqs takes its region and an emulator endpoint from QCLOUD_AWS_*', () => {
    const settings = runtimeSettingsFromEnv({
      ...BASE,
      QCLOUD_TRANSPORT: 'aws-sqs',
      QCLOUD_AWS_REGION: 'eu-west-1',
      QCLOUD_AWS_SQS_ENDPOINT: 'http://127.0.0.1:59324',
    });
    expect(settings).toMatchObject({
      transport: 'aws-sqs',
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:59324',
    });
    expect(
      runtimeSettingsFromEnv({
        ...BASE,
        QCLOUD_TRANSPORT: 'aws-sqs',
        QCLOUD_AWS_REGION: 'us-east-1',
      }).endpoint
    ).toBeUndefined();
  });

  test('reads the namespace, transport, project, pooler, commit, thresholds and fleet', () => {
    const settings = runtimeSettingsFromEnv({
      ...BASE,
      NODE_ENV: 'production',
      QCLOUD_NAMESPACE: 'prod',
      QCLOUD_TRANSPORT: 'postgres',
      QCLOUD_GCP_PROJECT: 'my-project',
      QCLOUD_DATABASE_POOLER: 'transaction',
      QCLOUD_API_HOST: '0.0.0.0',
      QCLOUD_API_PORT: '8081',
      QCLOUD_COMMIT: 'abc1234',
      QCLOUD_VERSION: '1.2.3',
      QCLOUD_API_TICK_LATE_AFTER_MS: '90000',
      QCLOUD_API_TICK_STALE_AFTER_MS: '400000',
      QCLOUD_API_DEPLOYMENT_CACHE_MS: '0',
      QCLOUD_API_TRANSPORT_MAX_QUEUES: '20',
      QCLOUD_FLEET_WORKERS: '4',
      QCLOUD_FLEET_POOL_SIZE: '3',
      QCLOUD_FLEET_LISTENERS: '1',
      QCLOUD_FLEET_POOLER_POOL_SIZE: '30',
      QCLOUD_API_SUMMARY_CACHE_MS: '5000',
      QCLOUD_API_EVENTS_HEARTBEAT_MS: '20000',
      QCLOUD_API_EVENTS_MAX_STREAMS: '50',
      QCLOUD_API_SHUTDOWN_GRACE_MS: '5000',
    });
    expect(settings).toMatchObject({
      namespace: 'prod',
      transport: 'postgres',
      projectId: 'my-project',
      listen: { hostname: '0.0.0.0', port: 8081 },
      shutdownGraceMs: 5_000,
      database: { pooler: 'transaction' },
    });
    expect(settings.api).toMatchObject({ version: '1.2.3', production: true });
    expect(settings.api.deployment).toEqual({
      commit: 'abc1234',
      tickLateAfterMs: 90_000,
      tickStaleAfterMs: 400_000,
      cacheMs: 0,
      maxQueues: 20,
      // The fleet goes through the pooler this process goes through.
      fleet: { workers: 4, poolSize: 3, listeners: 1, pooler: true, poolerPoolSize: 30 },
    });
    expect(settings.jobs).toEqual({
      summaryCacheMs: 5_000,
      events: { heartbeatMs: 20_000, maxStreams: 50 },
    });
  });

  describe('refuses a configuration that must not run', () => {
    test('the development token in production mode', () => {
      const message = refused(
        { QCLOUD_DATABASE_URL: URL, NODE_ENV: 'production', QCLOUD_API_DEV_TOKEN: TOKEN },
        ControlApiConfigError
      );
      expect(message).toMatch(/production/);
    });

    test('a wildcard, a path or "null" as a CORS origin', () => {
      for (const origin of [
        '*',
        'https://*.example.com',
        'https://panel.example.com/app',
        'null',
      ]) {
        refused({ ...BASE, QCLOUD_API_CORS_ORIGINS: origin }, ControlApiConfigError);
      }
      expect(
        runtimeSettingsFromEnv({ ...BASE, QCLOUD_API_CORS_ORIGINS: 'https://panel.example.com' })
          .api.corsOrigins
      ).toEqual(['https://panel.example.com']);
    });

    test('no way to sign in at all', () => {
      expect(refused({ QCLOUD_DATABASE_URL: URL }, ControlApiConfigError)).toMatch(
        /no authentication/
      );
    });

    test('the development token beyond loopback, unless the deployer says it is a private network', () => {
      const env = { QCLOUD_DATABASE_URL: URL, QCLOUD_API_DEV_TOKEN: TOKEN };
      expect(refused({ ...env, QCLOUD_API_HOST: '0.0.0.0' }, ControlApiConfigError)).toMatch(
        /QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK/
      );
      expect(
        runtimeSettingsFromEnv({
          ...env,
          QCLOUD_API_HOST: '0.0.0.0',
          QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK: 'true',
        }).listen.hostname
      ).toBe('0.0.0.0');
      expect(runtimeSettingsFromEnv(env).listen.hostname).toBe('127.0.0.1');
      refused(
        { ...env, QCLOUD_API_HOST: '0.0.0.0', QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK: 'yes' },
        ControlApiConfigError
      );
    });

    test('a short development token and a symmetric OIDC algorithm', () => {
      refused({ QCLOUD_DATABASE_URL: URL, QCLOUD_API_DEV_TOKEN: 'short' }, ControlApiConfigError);
      refused({ ...BASE, QCLOUD_API_OIDC_ALGORITHMS: 'HS256' }, ControlApiConfigError);
    });

    test('plain http for the JWKS URL in production', () => {
      refused(
        {
          ...BASE,
          NODE_ENV: 'production',
          QCLOUD_API_OIDC_JWKS_URL: 'http://accounts.example.com/jwks.json',
        },
        ControlApiConfigError
      );
    });

    test('a half-given OIDC configuration', () => {
      refused(
        { QCLOUD_DATABASE_URL: URL, QCLOUD_API_OIDC_ISSUER: OIDC.QCLOUD_API_OIDC_ISSUER },
        ControlApiConfigError
      );
    });

    test('thresholds that cannot be ordered, and a malformed number', () => {
      refused(
        {
          ...BASE,
          QCLOUD_API_TICK_LATE_AFTER_MS: '60000',
          QCLOUD_API_TICK_STALE_AFTER_MS: '60000',
        },
        ControlApiConfigError
      );
      refused({ ...BASE, QCLOUD_API_MAX_BODY_BYTES: '2MB' }, ControlApiConfigError);
    });

    test('an event heartbeat the panel would give up on, and a poll slower than it', () => {
      refused({ ...BASE, QCLOUD_API_EVENTS_HEARTBEAT_MS: '0' }, ControlApiConfigError);
      refused(
        { ...BASE, QCLOUD_API_EVENTS_POLL_MS: '20000', QCLOUD_API_EVENTS_HEARTBEAT_MS: '10000' },
        ControlApiConfigError
      );
    });

    test('fleet settings without the fleet size, and a malformed commit', () => {
      refused({ ...BASE, QCLOUD_FLEET_POOL_SIZE: '3' }, ControlApiConfigError);
      refused({ ...BASE, QCLOUD_COMMIT: 'not a commit!' }, ControlApiConfigError);
    });

    test('an unknown transport, a bad pooler, and a drain longer than the platform allows', () => {
      refused({ ...BASE, QCLOUD_TRANSPORT: 'sqs' }, ControlApiConfigError);
      // The region is never guessed from the machine, so AWS_REGION alone is not enough.
      refused(
        { ...BASE, QCLOUD_TRANSPORT: 'aws-sqs', AWS_REGION: 'eu-west-1' },
        ControlApiConfigError
      );
      refused({ ...BASE, QCLOUD_DATABASE_POOLER: 'session' }, UnsupportedOptionError);
      refused(
        { ...BASE, QCLOUD_API_SHUTDOWN_GRACE_MS: String(MAX_SHUTDOWN_GRACE_MS + 1) },
        ControlApiConfigError
      );
    });
  });
});
