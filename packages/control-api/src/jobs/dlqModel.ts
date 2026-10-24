import type {
  AttemptRecord,
  DlqStats,
  JobDetails,
  JobFailure,
  QueueConfig,
} from '@qelay-cloud/store-postgres';
import type { JobWire } from './model';
import { toJobWire } from './model';

/**
 * The dead-letter queue as the panel reads it: `DlqEntryFull`, `DlqStatsFull`, `StallConfig` and
 * `DlqConfig` of `../qelay-control-panel/src/lib/bqTypes.ts`. A DLQ entry is a failed job, so each
 * entry carries the job (with its payload cut to the list budget) beside how it failed.
 */

export interface DlqAttemptWire {
  readonly attempt: number;
  readonly startedAt: number;
  readonly failedAt: number;
  readonly reason: string;
  readonly error: string | null;
  readonly duration: number;
}

export interface DlqEntryWire {
  readonly job: JobWire;
  /** When the job's last attempt failed. */
  readonly enteredAt: number;
  /** Why it ended: `max_attempts_exceeded`, `explicit_fail`, `timeout` or `stalled`. */
  readonly reason: string;
  readonly error: string | null;
  readonly attempts: DlqAttemptWire[];
  /** When the queue's `maxAge` removes it, or null when entries are kept for ever. */
  readonly expiresAt: number | null;
}

const attemptWire = (record: AttemptRecord): DlqAttemptWire => ({
  attempt: record.attempt,
  startedAt: record.startedAt ?? record.failedAt - record.durationMs,
  failedAt: record.failedAt,
  reason: record.reason,
  error: record.error,
  duration: record.durationMs,
});

export interface DlqEntryOptions {
  readonly payloadBytes: number;
  /** The queue's `dlq.maxAge`, which dates `expiresAt`. */
  readonly maxAge: number | null;
}

/** One entry from the failed job's details and its failure read (null when it has none). */
export function toDlqEntryWire(
  details: JobDetails,
  failure: JobFailure | null,
  options: DlqEntryOptions
): DlqEntryWire {
  const last = failure?.attempts.at(-1);
  const enteredAt = details.completedAt ?? last?.failedAt ?? details.createdAt;
  return {
    job: toJobWire(details, { payloadBytes: options.payloadBytes, failure }),
    enteredAt,
    reason: failure?.reason ?? details.failedReason ?? '',
    error: details.failedReason ?? last?.error ?? null,
    attempts: (failure?.attempts ?? []).map(attemptWire),
    expiresAt: options.maxAge === null ? null : enteredAt + options.maxAge,
  };
}

export interface DlqStatsWire {
  readonly total: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly byQueue: Readonly<Record<string, number>>;
  /** Always 0: entries are not retried by the service, only by a caller. */
  readonly pendingRetry: number;
  /** Always 0: an entry past its `maxAge` is deleted by the tick, not kept as expired. */
  readonly expired: number;
  readonly oldestEntry: number | null;
  readonly newestEntry: number | null;
}

export const toDlqStatsWire = (queue: string, stats: DlqStats): DlqStatsWire => ({
  total: stats.total,
  byReason: stats.byReason,
  byQueue: { [queue]: stats.total },
  pendingRetry: 0,
  expired: 0,
  oldestEntry: stats.oldestFailedAt,
  newestEntry: stats.newestFailedAt,
});

/** `StallConfig`. Only `maxStalls` is a setting; the rest is how this service works. */
export interface StallConfigWire {
  readonly enabled: true;
  /** The lease length: a job is stalled when its lease expires without a heartbeat. */
  readonly stallInterval: number;
  readonly maxStalls: number;
  /** A lease has no separate grace period. */
  readonly gracePeriod: 0;
}

export const toStallConfigWire = (config: QueueConfig, leaseMs: number): StallConfigWire => ({
  enabled: true,
  stallInterval: leaseMs,
  maxStalls: config.stall.maxStalls,
  gracePeriod: 0,
});

/** What Qelay shows for the auto-retry settings the service does not have: its own defaults, fixed. */
const AUTO_RETRY_INTERVAL_MS = 3_600_000;
const MAX_AUTO_RETRIES = 3;

/** `DlqConfig`. `autoRetry` is always false: an entry is retried by a caller, never by the service (`dlq-auto-retry`). */
export interface DlqConfigWire {
  readonly autoRetry: false;
  readonly autoRetryInterval: number;
  readonly maxAutoRetries: number;
  readonly maxAge: number | null;
  readonly maxEntries: number;
}

export const toDlqConfigWire = (config: QueueConfig): DlqConfigWire => ({
  autoRetry: false,
  autoRetryInterval: AUTO_RETRY_INTERVAL_MS,
  maxAutoRetries: MAX_AUTO_RETRIES,
  maxAge: config.dlq.maxAge,
  maxEntries: config.dlq.maxEntries,
});
