import type { TransactionSQL } from 'bun';

/** What a claim needs of `qcloud_queue_state`. Stall and DLQ settings belong to tasks 14 and 15. */
export interface QueueState {
  readonly queue: string;
  readonly paused: boolean;
  readonly rateLimit: number | null;
  readonly rateDurationMs: number | null;
  readonly rateWindowStartedAt: number | null;
  readonly rateExpiresAt: number | null;
  readonly rateCount: number;
  readonly concurrencyLimit: number | null;
  /** The round-robin counter of the queue's groups (`last_served` values come from it). */
  readonly groupSequence: number;
}

interface QueueStateRow {
  queue: string;
  paused: boolean;
  rate_limit: number | null;
  rate_duration_ms: number | string | bigint | null;
  rate_window_started_at: number | string | bigint | null;
  rate_expires_at: number | string | bigint | null;
  rate_count: number;
  concurrency_limit: number | null;
  group_sequence: number | string | bigint;
}

const optional = (value: number | string | bigint | null): number | null =>
  value === null ? null : Number(value);

function toState(row: QueueStateRow): QueueState {
  return {
    queue: row.queue,
    paused: row.paused,
    rateLimit: row.rate_limit,
    rateDurationMs: optional(row.rate_duration_ms),
    rateWindowStartedAt: optional(row.rate_window_started_at),
    rateExpiresAt: optional(row.rate_expires_at),
    rateCount: row.rate_count,
    concurrencyLimit: row.concurrency_limit,
    groupSequence: Number(row.group_sequence),
  };
}

/**
 * Locks the queue's state row and reads it. Shared: concurrent claims of a queue with no limit and
 * no groups run together. Exclusive: a claim that must count against a limit or rotate groups
 * runs alone, so two claimers cannot both see room for the last slot. Creates the row if it is
 * missing (a queue nobody enqueued to has none). Adapted from Qelay's `claims.ts`.
 */
export async function lockQueueState(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  exclusive: boolean
): Promise<QueueState> {
  const select = () =>
    exclusive
      ? tx<QueueStateRow[]>`
          SELECT queue, paused, rate_limit, rate_duration_ms, rate_window_started_at,
                 rate_expires_at, rate_count, concurrency_limit, group_sequence
          FROM qcloud_queue_state
          WHERE namespace = ${namespace} AND queue = ${queue}
          FOR UPDATE`
      : tx<QueueStateRow[]>`
          SELECT queue, paused, rate_limit, rate_duration_ms, rate_window_started_at,
                 rate_expires_at, rate_count, concurrency_limit, group_sequence
          FROM qcloud_queue_state
          WHERE namespace = ${namespace} AND queue = ${queue}
          FOR SHARE`;
  let rows = await select();
  if (rows.length === 0) {
    await tx`
      INSERT INTO qcloud_queue_state (namespace, queue)
      VALUES (${namespace}, ${queue})
      ON CONFLICT DO NOTHING`;
    rows = await select();
  }
  const [row] = rows;
  if (!row) throw new Error(`the queue state of ${queue} disappeared while it was being locked`);
  return toState(row);
}

/** Default window of a rate limit that names none. */
export const DEFAULT_RATE_DURATION_MS = 1000;

/**
 * Applies the fixed window to a state row that is locked exclusively: an expired limit is
 * removed, and a window that has run out starts a new one with a count of 0.
 */
export async function refreshRateWindow(
  tx: TransactionSQL,
  namespace: string,
  state: QueueState,
  now: number
): Promise<QueueState> {
  if (state.rateLimit === null) return state;
  if (state.rateExpiresAt !== null && state.rateExpiresAt <= now) {
    await tx`
      UPDATE qcloud_queue_state
      SET rate_limit = NULL, rate_duration_ms = NULL, rate_window_started_at = NULL,
          rate_expires_at = NULL, rate_count = 0
      WHERE namespace = ${namespace} AND queue = ${state.queue}`;
    return {
      ...state,
      rateLimit: null,
      rateDurationMs: null,
      rateWindowStartedAt: null,
      rateExpiresAt: null,
      rateCount: 0,
    };
  }
  const duration = state.rateDurationMs ?? DEFAULT_RATE_DURATION_MS;
  if (state.rateWindowStartedAt !== null && now < state.rateWindowStartedAt + duration) {
    return state;
  }
  await tx`
    UPDATE qcloud_queue_state SET rate_window_started_at = ${now}, rate_count = 0
    WHERE namespace = ${namespace} AND queue = ${state.queue}`;
  return { ...state, rateWindowStartedAt: now, rateCount: 0 };
}

/** Jobs of the queue that hold an unexpired lease. An expired lease is the tick's to recover. */
export async function countActive(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  now: number
): Promise<number> {
  const [row] = await tx<{ count: number | string | bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM qcloud_jobs
    WHERE namespace = ${namespace} AND queue = ${queue}
      AND state = 'active' AND lease_until > ${now}`;
  return Number(row!.count);
}
