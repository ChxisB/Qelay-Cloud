import { MAX_REQUEST_BODY_BYTES, UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions } from '@qelay-cloud/store-postgres';
import { databaseOptionsForNamespace, webhookSettingsFromEnv } from '@qelay-cloud/store-postgres';

export type Env = Readonly<Record<string, string | undefined>>;

export interface IngestLimits {
  /** Largest body taken, in bytes; at most `MAX_REQUEST_BODY_BYTES`. */
  readonly maxBodyBytes: number;
  /** The whole body must arrive within this, or the request is cut off. */
  readonly readTimeoutMs: number;
  /** Requests one source takes in a fixed minute; the ones over it get a 429 and store nothing. */
  readonly perSourcePerMinute: number;
  /** Requests the process takes in a fixed minute, whatever the token. */
  readonly globalPerMinute: number;
}

export interface IngestSettings {
  readonly namespace: string;
  readonly database: DatabaseOptions;
  /** The key a source's secret is sealed with; without it a source that verifies accepts nothing. */
  readonly webhookKey: string | undefined;
  readonly hostname: string;
  readonly port: number;
  readonly limits: IngestLimits;
  readonly shutdownGraceMs: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxBodyBytes: MAX_REQUEST_BODY_BYTES,
  readTimeoutMs: 10_000,
  perSourcePerMinute: 600,
  globalPerMinute: 6_000,
};
/** Cloud Run sends SIGKILL ten seconds after SIGTERM: the drain must end before it. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8_000;
export const MAX_SHUTDOWN_GRACE_MS = 60_000;

const text = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

function integer(env: Env, name: string, min: number, max: number): number | undefined {
  const raw = text(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new UnsupportedOptionError(name, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Everything the process takes from its environment, checked before anything connects. No message repeats a value. */
export function ingestSettingsFromEnv(env: Env): IngestSettings {
  const namespace = text(env, 'QCLOUD_NAMESPACE') ?? 'default';
  const limits: IngestLimits = {
    maxBodyBytes:
      integer(env, 'QCLOUD_INGEST_MAX_BODY_BYTES', 1, MAX_REQUEST_BODY_BYTES) ??
      DEFAULT_LIMITS.maxBodyBytes,
    readTimeoutMs:
      integer(env, 'QCLOUD_INGEST_READ_TIMEOUT_MS', 100, 60_000) ?? DEFAULT_LIMITS.readTimeoutMs,
    perSourcePerMinute:
      integer(env, 'QCLOUD_INGEST_RATE_PER_SOURCE', 1, 1_000_000) ??
      DEFAULT_LIMITS.perSourcePerMinute,
    globalPerMinute:
      integer(env, 'QCLOUD_INGEST_RATE_GLOBAL', 1, 10_000_000) ?? DEFAULT_LIMITS.globalPerMinute,
  };
  return {
    namespace,
    database: databaseOptionsForNamespace(env, namespace, {
      applicationName: 'qcloud-ingest',
      purpose: 'the database the ingest stores requests in',
    }),
    webhookKey: webhookSettingsFromEnv(env).key,
    hostname: text(env, 'QCLOUD_INGEST_HOST') ?? '127.0.0.1',
    port: integer(env, 'QCLOUD_INGEST_PORT', 0, 65_535) ?? 8081,
    limits,
    shutdownGraceMs:
      integer(env, 'QCLOUD_INGEST_SHUTDOWN_GRACE_MS', 0, MAX_SHUTDOWN_GRACE_MS) ??
      DEFAULT_SHUTDOWN_GRACE_MS,
  };
}
