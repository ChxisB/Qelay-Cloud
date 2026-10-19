import type { Codec, Ring } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { Database } from '../connection/connect';
import type { BackoffPolicy } from './backoff';
import type { EventRecorder } from './events';
import type { PrepareLimits } from './prepare';

/** A job that just reached the end of its run: `completed`, or `failed` (in the DLQ or removed). */
export interface TerminalChange {
  readonly jobId: string;
  readonly queue: string;
  /** The flow parent waiting on this job, if any. */
  readonly parentId: string | null;
  readonly outcome: 'completed' | 'failed';
  /** For `failed`: why, as recorded on the job. A flow parent that is failed by it quotes this. */
  readonly error?: string;
}

/**
 * Called inside the transaction that made the change, after its writes and before its metrics, with
 * every job that finished in it. Flow-parent promotion (`flowTerminal.ts`) plugs in here, so a parent never
 * becomes claimable for a child whose completion rolled back. Returns the rings the change earned,
 * which the operation hands back to its caller. A hook that throws rolls the whole operation back.
 */
export type TerminalHook = (
  tx: TransactionSQL,
  changes: readonly TerminalChange[],
  now: number
) => Promise<readonly Ring[]>;

export const noTerminalHook: TerminalHook = async () => [];

/** What every store operation needs. Built once by `PostgresStore`. */
export interface StoreContext {
  readonly db: Database;
  /** Tenant of every row this store reads or writes. */
  readonly namespace: string;
  readonly codec: Codec;
  /** A new job id for the operation's `now`. */
  readonly nextId: (now: number) => string;
  readonly recorder: EventRecorder;
  /** Longest delay the transport can hold a bell for. 0: it cannot delay delivery at all. */
  readonly ringWindowMs: number;
  /** A new job whose queue has a claimable job rung within this many ms is not rung (`ringCover.ts`). 0: every job is rung. */
  readonly ringCoverMs: number;
  readonly limits: PrepareLimits;
  /** How long a lease lasts from a claim or a heartbeat, before the job's own timeouts shorten it. */
  readonly leaseMs: number;
  /** Jitter and its randomness for retry delays. */
  readonly backoff: BackoffPolicy;
  /** Minutes of per-minute metric buckets kept. 0: lifetime totals only. */
  readonly maxMetricBuckets: number;
  readonly onTerminal: TerminalHook;
  /** A worker whose last heartbeat is at least this old no longer counts as active. */
  readonly workerActiveMs: number;
  /** A worker whose last heartbeat is at least this old is deleted by the tick. */
  readonly workerExpireMs: number;
  /** Events the journal keeps per queue; past it the tick deletes the oldest. */
  readonly maxQueueEvents: number;
  /** How long the journal keeps an event. */
  readonly eventRetentionMs: number;
  /** Log lines kept per job. */
  readonly maxJobLogs: number;
  /** Newest completions whose records are kept when their jobs are gone. */
  readonly maxCompletedJobs: number;
  /** How long the operator audit log keeps an entry. */
  readonly auditRetentionMs: number;
  /** Entries the operator audit log keeps; past it the oldest go. */
  readonly maxAuditEntries: number;
  /** How long a finished webhook delivery stays readable. */
  readonly webhookKeepMs: number;
  /** The key webhook secrets are sealed with (32 bytes), or null: then a webhook cannot be given a secret. */
  readonly webhookKey: Uint8Array | null;
}
