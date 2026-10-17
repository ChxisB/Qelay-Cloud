import { readFileSync } from 'node:fs';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions } from './connect';

type Env = Readonly<Record<string, string | undefined>>;

/** The per-process pool, from `QCLOUD_DATABASE_POOL_SIZE`: the number the infrastructure's connection budget counts. */
function poolSizeFromEnv(env: Env): number | undefined {
  const raw = env.QCLOUD_DATABASE_POOL_SIZE;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(
      'QCLOUD_DATABASE_POOL_SIZE',
      `must be a positive integer, not "${raw}"`
    );
  }
  return value;
}

export interface DatabaseEnvOptions {
  /** Shown by `pg_stat_activity`, so a connection can be traced to its process. */
  readonly applicationName: string;
  /** Finishes "QCLOUD_DATABASE_URL is required: ..." for the process that asks. */
  readonly purpose: string;
}

/**
 * The database connection every Qelay Cloud process takes from its environment: the URL and the
 * secrets in it come only from here (a flag shows in the process list), and an error names the
 * variable and never repeats a value that could be a credential.
 *
 * `QCLOUD_DATABASE_URL` (required), `QCLOUD_DATABASE_LISTEN_URL`, `QCLOUD_DATABASE_POOLER`
 * (`none` | `transaction`), `QCLOUD_DATABASE_POOL_SIZE`, `QCLOUD_DATABASE_SCHEMA` (a direct
 * connection only; behind a pooler, set the role's `search_path`), and one of `QCLOUD_DATABASE_TLS`
 * (`unverified` | `off`), `QCLOUD_DATABASE_TLS_CA_FILE` (a path) or `QCLOUD_DATABASE_TLS_CA` (the PEM
 * itself, for a platform that can inject environment variables but not mount a file).
 */
export function databaseOptionsFromEnv(env: Env, options: DatabaseEnvOptions): DatabaseOptions {
  const url = env.QCLOUD_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new UnsupportedOptionError('QCLOUD_DATABASE_URL', `is required: ${options.purpose}`);
  }
  const pooler = env.QCLOUD_DATABASE_POOLER ?? 'none';
  if (pooler !== 'none' && pooler !== 'transaction') {
    throw new UnsupportedOptionError('QCLOUD_DATABASE_POOLER', 'must be "none" or "transaction"');
  }
  const tlsMode = env.QCLOUD_DATABASE_TLS;
  const caFile = env.QCLOUD_DATABASE_TLS_CA_FILE;
  const caPem = env.QCLOUD_DATABASE_TLS_CA;
  if (tlsMode !== undefined && tlsMode !== 'unverified' && tlsMode !== 'off') {
    throw new UnsupportedOptionError('QCLOUD_DATABASE_TLS', 'must be "unverified" or "off"');
  }
  if (tlsMode !== undefined && caFile !== undefined) {
    throw new UnsupportedOptionError(
      'QCLOUD_DATABASE_TLS_CA_FILE',
      'conflicts with QCLOUD_DATABASE_TLS: choose one'
    );
  }
  if (caPem !== undefined) {
    if (caPem === '') {
      throw new UnsupportedOptionError(
        'QCLOUD_DATABASE_TLS_CA',
        'is empty: unset it or give a PEM'
      );
    }
    if (tlsMode !== undefined || caFile !== undefined) {
      throw new UnsupportedOptionError(
        'QCLOUD_DATABASE_TLS_CA',
        'conflicts with QCLOUD_DATABASE_TLS and QCLOUD_DATABASE_TLS_CA_FILE: choose one'
      );
    }
  }
  const tls =
    caPem !== undefined
      ? { ca: caPem }
      : caFile !== undefined
        ? { ca: readFileSync(caFile, 'utf8') }
        : tlsMode === undefined
          ? undefined
          : tlsMode === 'off'
            ? (false as const)
            : ('unverified' as const);
  const poolSize = poolSizeFromEnv(env);
  const schema = env.QCLOUD_DATABASE_SCHEMA;
  return {
    url,
    pooler,
    applicationName: options.applicationName,
    ...(poolSize === undefined ? {} : { poolSize }),
    ...(tls === undefined ? {} : { tls }),
    ...(schema === undefined || schema === '' ? {} : { schema }),
    ...(env.QCLOUD_DATABASE_LISTEN_URL ? { listenUrl: env.QCLOUD_DATABASE_LISTEN_URL } : {}),
  };
}
