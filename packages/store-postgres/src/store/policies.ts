import type { Codec } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';

/**
 * The queue settings recovery and the DLQ read. Adapted from Qelay's `policies.ts`, `StallConfig`
 * and `DlqConfig` (see docs/PORTING.md). The settings live in `qcloud_queue_state.stall_config` and
 * `dlq_config` as codec-encoded objects; task 15 writes them. Only the fields this store acts on are
 * read: of the stall config `maxStalls` (leases replace heartbeat-gap detection, so `enabled`,
 * `stallInterval` and `gracePeriod` have no work to do), of the DLQ config `maxEntries` and `maxAge`
 * (auto-retry stays closed, see the task 14 Result).
 */
export interface QueuePolicies {
  /** Stalls a job may have before it goes to the DLQ even with attempts left. 0: no limit. */
  readonly maxStalls: number;
  /** Failed jobs a queue keeps, newest first (at least 1). */
  readonly maxEntries: number;
  /** Milliseconds a failed job stays in the DLQ, or null for ever. */
  readonly maxAge: number | null;
}

export const DEFAULT_MAX_STALLS = 3;
export const DEFAULT_DLQ_MAX_ENTRIES = 10_000;
/** Seven days, upstream's default. */
export const DEFAULT_DLQ_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_POLICIES: QueuePolicies = {
  maxStalls: DEFAULT_MAX_STALLS,
  maxEntries: DEFAULT_DLQ_MAX_ENTRIES,
  maxAge: DEFAULT_DLQ_MAX_AGE_MS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const whole = (value: unknown, min: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : null;

/** A field of the wrong type takes its default; so does a missing config. */
export function decodeStallConfig(codec: Codec, bytes: Uint8Array | null): number {
  const raw = bytes === null ? null : codec.decode(bytes);
  return (isRecord(raw) ? whole(raw.maxStalls, 0) : null) ?? DEFAULT_MAX_STALLS;
}

export function decodeDlqConfig(
  codec: Codec,
  bytes: Uint8Array | null
): Pick<QueuePolicies, 'maxEntries' | 'maxAge'> {
  const raw = bytes === null ? null : codec.decode(bytes);
  if (!isRecord(raw))
    return { maxEntries: DEFAULT_DLQ_MAX_ENTRIES, maxAge: DEFAULT_DLQ_MAX_AGE_MS };
  return {
    maxEntries: whole(raw.maxEntries, 1) ?? DEFAULT_DLQ_MAX_ENTRIES,
    maxAge: raw.maxAge === null ? null : (whole(raw.maxAge, 1) ?? DEFAULT_DLQ_MAX_AGE_MS),
  };
}

interface PolicyRow {
  readonly stall_config: Uint8Array | null;
  readonly dlq_config: Uint8Array | null;
}

/**
 * Reads a queue's policies inside the operation's transaction, once per queue (a recovery batch
 * can hold jobs of many). A queue with no state row has the defaults.
 */
export function policyReader(
  tx: TransactionSQL,
  ctx: StoreContext
): (queue: string) => Promise<QueuePolicies> {
  const cache = new Map<string, QueuePolicies>();
  return async (queue) => {
    const known = cache.get(queue);
    if (known) return known;
    const [row] = await tx<PolicyRow[]>`
      SELECT stall_config, dlq_config FROM qcloud_queue_state
      WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
    const policies: QueuePolicies = row
      ? {
          maxStalls: decodeStallConfig(ctx.codec, row.stall_config),
          ...decodeDlqConfig(ctx.codec, row.dlq_config),
        }
      : DEFAULT_POLICIES;
    cache.set(queue, policies);
    return policies;
  };
}
