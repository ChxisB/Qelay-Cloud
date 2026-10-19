import { describe, expect, test } from 'bun:test';
import { STRICT_URL_POLICY, UnsupportedOptionError } from '@qelay-cloud/core';
import { settingsFromEnv } from '../src/env';
import { redactor } from '../src/redact';
import {
  DEFAULT_WEBHOOK_BATCH,
  MIN_LEASE_MARGIN_MS,
  resolveWebhookConfig,
  webhookOptionsFromEnv,
} from '../src/webhookConfig';

const DATABASE = 'postgres://qcloud:hunter2@db.internal:5432/qcloud';
const KEY_HEX = 'ab'.repeat(32);

describe('webhook settings from the environment', () => {
  test('with nothing set: no key, the strict address policy, default sender options', () => {
    const settings = settingsFromEnv({ QCLOUD_DATABASE_URL: DATABASE }).webhooks;
    expect(settings).toEqual({ urlPolicy: STRICT_URL_POLICY, sender: {} });
    expect(settings.key).toBeUndefined();
  });

  test('a 64-digit hex key and a base64 key are both accepted', () => {
    const base64 = Buffer.alloc(32, 7).toString('base64');
    for (const key of [KEY_HEX, base64]) {
      const settings = settingsFromEnv({ QCLOUD_DATABASE_URL: DATABASE, QCLOUD_WEBHOOK_KEY: key });
      expect(settings.webhooks.key).toBe(key);
    }
  });

  test('a bad key is refused by name and the key is never echoed', () => {
    for (const key of ['short', 'zz'.repeat(32), 'ab'.repeat(31)]) {
      let thrown: unknown;
      try {
        settingsFromEnv({ QCLOUD_DATABASE_URL: DATABASE, QCLOUD_WEBHOOK_KEY: key });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedOptionError);
      expect(String((thrown as Error).message)).toContain('QCLOUD_WEBHOOK_KEY');
      expect(String((thrown as Error).message)).not.toContain(key);
    }
  });

  test('development mode is an explicit boolean, and anything else is refused', () => {
    const policy = (value: string) =>
      settingsFromEnv({ QCLOUD_DATABASE_URL: DATABASE, QCLOUD_WEBHOOK_DEV_MODE: value }).webhooks
        .urlPolicy;
    expect(policy('true')).toEqual({ allowHttp: true, allowPrivate: true });
    expect(policy('1')).toEqual({ allowHttp: true, allowPrivate: true });
    expect(policy('false')).toEqual(STRICT_URL_POLICY);
    expect(policy('0')).toEqual(STRICT_URL_POLICY);
    expect(policy('')).toEqual(STRICT_URL_POLICY);
    for (const bad of ['yes', 'on', 'dev', 'enabled']) {
      expect(() => policy(bad)).toThrow(/QCLOUD_WEBHOOK_DEV_MODE/u);
    }
  });

  test('every sender variable is read into its option', () => {
    expect(
      webhookOptionsFromEnv({
        QCLOUD_WEBHOOK_BATCH: '20',
        QCLOUD_WEBHOOK_CONCURRENCY: '4',
        QCLOUD_WEBHOOK_BUDGET_MS: '3000',
        QCLOUD_WEBHOOK_TIMEOUT_MS: '8000',
        QCLOUD_WEBHOOK_LEASE_MS: '20000',
        QCLOUD_WEBHOOK_RATE_PER_MINUTE: '30',
        QCLOUD_WEBHOOK_MAX_ATTEMPTS: '5',
        QCLOUD_WEBHOOK_BASE_DELAY_MS: '2000',
        QCLOUD_WEBHOOK_MAX_DELAY_MS: '600000',
        QCLOUD_WEBHOOK_KEEPALIVE_MS: '5000',
        QCLOUD_WEBHOOK_DNS_TTL_MS: '0',
        QCLOUD_WEBHOOK_PER_DESTINATION: '2',
        QCLOUD_WEBHOOK_BREAKER_FAILURES: '0',
        QCLOUD_WEBHOOK_BREAKER_COOLDOWN_MS: '9000',
        QCLOUD_WEBHOOK_IDLE_MS: '100',
      })
    ).toEqual({
      batch: 20,
      concurrency: 4,
      budgetMs: 3_000,
      timeoutMs: 8_000,
      leaseMs: 20_000,
      ratePerMinute: 30,
      maxAttempts: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 600_000,
      keepAliveMs: 5_000,
      dnsTtlMs: 0,
      perDestination: 2,
      breakerFailures: 0,
      breakerCooldownMs: 9_000,
      idleMs: 100,
    });
    expect(webhookOptionsFromEnv({ QCLOUD_WEBHOOK_BATCH: '' })).toEqual({});
  });

  test('a malformed number names its variable', () => {
    for (const bad of ['-1', '1.5', '10s', 'NaN', '1e3', '99999999999999999999']) {
      expect(() => webhookOptionsFromEnv({ QCLOUD_WEBHOOK_TIMEOUT_MS: bad })).toThrow(
        /QCLOUD_WEBHOOK_TIMEOUT_MS/u
      );
    }
  });
});

describe('resolveWebhookConfig', () => {
  test('fills every default, and an unset batch is the default batch', () => {
    const config = resolveWebhookConfig({}, STRICT_URL_POLICY)!;
    expect(config).toMatchObject({
      batch: DEFAULT_WEBHOOK_BATCH,
      concurrency: 8,
      budgetMs: 5_000,
      timeoutMs: 10_000,
      leaseMs: 30_000,
      ratePerMinute: 60,
      retry: { maxAttempts: 8, baseDelayMs: 30_000, maxDelayMs: 3_600_000 },
      keepAliveMs: 15_000,
      dnsTtlMs: 30_000,
      perDestination: 4,
      breakerFailures: 5,
      breakerCooldownMs: 30_000,
      idleMs: 500,
    });
    expect(config.urlPolicy).toBe(STRICT_URL_POLICY);
  });

  test('a batch of 0 turns sending off', () => {
    expect(resolveWebhookConfig({ batch: 0 }, STRICT_URL_POLICY)).toBeNull();
  });

  test('a lease must outlast the request timeout by the margin', () => {
    expect(() =>
      resolveWebhookConfig(
        { timeoutMs: 10_000, leaseMs: 10_000 + MIN_LEASE_MARGIN_MS - 1 },
        STRICT_URL_POLICY
      )
    ).toThrow(/leaseMs/u);
    expect(
      resolveWebhookConfig(
        { timeoutMs: 10_000, leaseMs: 10_000 + MIN_LEASE_MARGIN_MS },
        STRICT_URL_POLICY
      )
    ).not.toBeNull();
  });

  test('a zero or negative value is refused by name', () => {
    for (const name of [
      'concurrency',
      'budgetMs',
      'timeoutMs',
      'ratePerMinute',
      'perDestination',
      'breakerCooldownMs',
      'idleMs',
    ] as const) {
      expect(() => resolveWebhookConfig({ [name]: 0 }, STRICT_URL_POLICY)).toThrow(
        new RegExp(name, 'u')
      );
    }
    expect(() => resolveWebhookConfig({ batch: -1 }, STRICT_URL_POLICY)).toThrow(/batch/u);
  });

  test('keep-alive, the name cache and the breaker can each be turned off with 0', () => {
    const config = resolveWebhookConfig(
      { keepAliveMs: 0, dnsTtlMs: 0, breakerFailures: 0 },
      STRICT_URL_POLICY
    )!;
    expect(config).toMatchObject({ keepAliveMs: 0, dnsTtlMs: 0, breakerFailures: 0 });
    expect(() => resolveWebhookConfig({ keepAliveMs: -1 }, STRICT_URL_POLICY)).toThrow(
      /keepAliveMs/u
    );
  });

  test('a failed answer is kept to 1 KB by default, none when private addresses are allowed', () => {
    expect(resolveWebhookConfig({}, STRICT_URL_POLICY)!.responseBytes).toBe(1_024);
    const open = { allowHttp: true, allowPrivate: true };
    expect(resolveWebhookConfig({}, open)!.responseBytes).toBe(0);
    expect(resolveWebhookConfig({ responseBytes: 512 }, open)!.responseBytes).toBe(512);
    expect(() => resolveWebhookConfig({ responseBytes: 5_000 }, STRICT_URL_POLICY)).toThrow(
      /responseBytes/u
    );
  });

  test('the User-Agent comes from the environment and must be plain text', () => {
    const options = webhookOptionsFromEnv({
      QCLOUD_WEBHOOK_USER_AGENT: 'acme/1',
      QCLOUD_WEBHOOK_RESPONSE_BYTES: '256',
    });
    expect(resolveWebhookConfig(options, STRICT_URL_POLICY)).toMatchObject({
      userAgent: 'acme/1',
      responseBytes: 256,
    });
    expect(resolveWebhookConfig({}, STRICT_URL_POLICY)!.userAgent).toBe('qelay-cloud-webhooks/1');
    expect(() => resolveWebhookConfig({ userAgent: 'a\r\nX: 1' }, STRICT_URL_POLICY)).toThrow(
      /userAgent/u
    );
  });

  test('an attempt budget below 1 is refused', () => {
    expect(() => resolveWebhookConfig({ maxAttempts: 0 }, STRICT_URL_POLICY)).toThrow();
  });
});

describe('the webhook key in logs', () => {
  test('is redacted from any text the process prints', () => {
    const redact = redactor({ QCLOUD_DATABASE_URL: DATABASE, QCLOUD_WEBHOOK_KEY: KEY_HEX });
    const line = redact(`could not open the store with key ${KEY_HEX}`);
    expect(line).not.toContain(KEY_HEX);
  });
});
