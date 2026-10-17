import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { enforceDlqLimit } from './dlq';
import { decodeDlqConfig, decodeStallConfig } from './policies';
import { identifier } from './prepare';
import { DEFAULT_RATE_DURATION_MS, lockQueueState } from './queueState';
import { runTransaction } from './retry';

/**
 * Reading and writing a queue's whole configuration. Pause, resume and the two limits have their
 * own operations (`limits.ts`); this module adds what had no setter, the stall and DLQ settings,
 * and a read that puts all of them together for the panel and the Control API.
 *
 * The stall and DLQ settings are codec-encoded objects in `qcloud_queue_state`. A setter is a
 * patch: only the keys it is given are written, so a save that omits one leaves it as it was
 * (the panel's save omits the DLQ's `maxAge` and `maxEntries`, which it shows read-only; the
 * Control API enforces that, not the store). A key the store does not act on is refused instead of
 * being stored and ignored: `autoRetry` of the DLQ stays closed (task 14 Result).
 */

export interface QueueConfig {
  readonly queue: string;
  readonly paused: boolean;
  /** The rate limit, or null when there is none or its expiry has passed. */
  readonly rateLimit: {
    readonly max: number;
    readonly durationMs: number;
    readonly expiresAt: number | null;
  } | null;
  readonly concurrencyLimit: number | null;
  readonly stall: { readonly maxStalls: number };
  readonly dlq: { readonly maxEntries: number; readonly maxAge: number | null };
}

export interface StallConfigPatch {
  /** Stalls a job may have before it goes to the DLQ even with attempts left. 0: no limit. */
  readonly maxStalls?: number;
}

export interface DlqConfigPatch {
  /** Failed jobs the queue keeps, newest first. At least 1. */
  readonly maxEntries?: number;
  /** Milliseconds a failed job stays, or null for ever. */
  readonly maxAge?: number | null;
}

const MAX_INTEGER = 2_147_483_647;

interface ConfigRow {
  readonly paused: boolean;
  readonly rate_limit: number | null;
  readonly rate_duration_ms: number | string | bigint | null;
  readonly rate_expires_at: number | string | bigint | null;
  readonly concurrency_limit: number | null;
  readonly stall_config: Uint8Array | null;
  readonly dlq_config: Uint8Array | null;
}

function toConfig(ctx: StoreContext, queue: string, row: ConfigRow | undefined, now: number) {
  const expiresAt = row?.rate_expires_at == null ? null : Number(row.rate_expires_at);
  const limited =
    row !== undefined && row.rate_limit !== null && !(expiresAt !== null && expiresAt <= now);
  const config: QueueConfig = {
    queue,
    paused: row?.paused ?? false,
    rateLimit: limited
      ? {
          max: row.rate_limit!,
          durationMs:
            row.rate_duration_ms === null ? DEFAULT_RATE_DURATION_MS : Number(row.rate_duration_ms),
          expiresAt,
        }
      : null,
    concurrencyLimit: row?.concurrency_limit ?? null,
    stall: { maxStalls: decodeStallConfig(ctx.codec, row?.stall_config ?? null) },
    dlq: decodeDlqConfig(ctx.codec, row?.dlq_config ?? null),
  };
  return config;
}

/** A queue that was never used has the defaults and no row. */
export async function getQueueConfig(ctx: StoreContext, name: string): Promise<QueueConfig> {
  const queue = identifier('queue', name);
  return ctx.db.run('getQueueConfig', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<ConfigRow[]>`
      SELECT paused, rate_limit, rate_duration_ms, rate_expires_at, concurrency_limit,
             stall_config, dlq_config
      FROM qcloud_queue_state
      WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
    return toConfig(ctx, queue, row, now);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function integer(name: string, value: unknown, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > MAX_INTEGER) {
    throw new UnsupportedOptionError(name, `must be an integer from ${min} to ${MAX_INTEGER}`);
  }
  return value as number;
}

/** The keys of `patch` that are set, checked against `allowed`; an unknown key is refused. */
function setKeys(scope: string, patch: unknown, allowed: readonly string[]): string[] {
  if (!isRecord(patch)) throw new UnsupportedOptionError(scope, 'must be an object');
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new UnsupportedOptionError(`${scope}.${key}`, `is not a setting of this store`);
    }
  }
  return keys;
}

export function validateStallPatch(patch: StallConfigPatch): Record<string, number> {
  const keys = setKeys('stall', patch, ['maxStalls']);
  return keys.includes('maxStalls')
    ? { maxStalls: integer('stall.maxStalls', patch.maxStalls, 0) }
    : {};
}

export function validateDlqPatch(patch: DlqConfigPatch): Record<string, number | null> {
  const keys = setKeys('dlq', patch, ['maxEntries', 'maxAge']);
  const valid: Record<string, number | null> = {};
  if (keys.includes('maxEntries'))
    valid.maxEntries = integer('dlq.maxEntries', patch.maxEntries, 1);
  if (keys.includes('maxAge')) {
    valid.maxAge = patch.maxAge === null ? null : integer('dlq.maxAge', patch.maxAge, 1);
  }
  return valid;
}

/** The stored object with `patch` laid over it. Keys the store does not read are kept as they are. */
function merged(ctx: StoreContext, stored: Uint8Array | null, patch: object): Uint8Array {
  const before = stored === null ? null : ctx.codec.decode(stored);
  return ctx.codec.encode({ ...(isRecord(before) ? before : {}), ...patch });
}

type Column = 'stall_config' | 'dlq_config';

async function patchQueue(
  ctx: StoreContext,
  operation: string,
  name: string,
  column: Column,
  patch: Record<string, unknown>,
  afterWrite?: (tx: TransactionSQL, config: QueueConfig, now: number) => Promise<void>
): Promise<QueueConfig> {
  const queue = identifier('queue', name);
  return ctx.db.run(operation, (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // The row is created if missing and locked, so two patches of one queue cannot overwrite each other.
      await lockQueueState(tx, ctx.namespace, queue, true);
      const [row] = await tx<ConfigRow[]>`
        SELECT paused, rate_limit, rate_duration_ms, rate_expires_at, concurrency_limit,
               stall_config, dlq_config
        FROM qcloud_queue_state
        WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
      if (Object.keys(patch).length === 0) return toConfig(ctx, queue, row, now);
      const blob = merged(
        ctx,
        column === 'stall_config' ? row!.stall_config : row!.dlq_config,
        patch
      );
      const [written] =
        column === 'stall_config'
          ? await tx<ConfigRow[]>`
              UPDATE qcloud_queue_state SET stall_config = ${blob}
              WHERE namespace = ${ctx.namespace} AND queue = ${queue}
              RETURNING paused, rate_limit, rate_duration_ms, rate_expires_at, concurrency_limit,
                        stall_config, dlq_config`
          : await tx<ConfigRow[]>`
              UPDATE qcloud_queue_state SET dlq_config = ${blob}
              WHERE namespace = ${ctx.namespace} AND queue = ${queue}
              RETURNING paused, rate_limit, rate_duration_ms, rate_expires_at, concurrency_limit,
                        stall_config, dlq_config`;
      const config = toConfig(ctx, queue, written, now);
      await afterWrite?.(tx, config, now);
      return config;
    })
  );
}

/**
 * Sets the queue's stall settings. Only the keys given change. Takes effect for the next
 * recovery: a job already in the DLQ stays there.
 */
export async function setStallConfig(
  ctx: StoreContext,
  queue: string,
  patch: StallConfigPatch
): Promise<QueueConfig> {
  return patchQueue(ctx, 'setStallConfig', queue, 'stall_config', validateStallPatch(patch));
}

/**
 * Sets the queue's DLQ settings. Only the keys given change. Lowering `maxEntries` trims the DLQ
 * to the new limit in the same transaction, oldest first, journaling each deletion. `maxAge` is
 * measured from each entry's failure, so a change applies to entries already there at the next
 * tick (`purgeExpiredDlq`).
 */
export async function setDlqConfig(
  ctx: StoreContext,
  queue: string,
  patch: DlqConfigPatch
): Promise<QueueConfig> {
  const valid = validateDlqPatch(patch);
  return patchQueue(ctx, 'setDlqConfig', queue, 'dlq_config', valid, async (tx, config, now) => {
    if ('maxEntries' in valid) {
      await enforceDlqLimit(tx, ctx, config.queue, config.dlq.maxEntries, now);
    }
  });
}
