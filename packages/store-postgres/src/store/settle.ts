import type { Ring } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { retryDelayMs } from './backoff';
import type { StoreContext } from './context';
import type { StoreEvent } from './events';
import type { HeldRow } from './jobRow';
import type { QueuePolicies } from './policies';
import type { Envelope } from './prepare';
import { deleteJobRows } from './remove';
import type { AttemptRecord, DlqBlob, FailureReason, RetryState } from './retryState';
import { decodeRetryState, withAttempt } from './retryState';
import { initialState, ringFor } from './state';

/** Upstream's default retry delay for a payload that carries no backoff. */
const FALLBACK_BACKOFF: Envelope['backoff'] = { type: 'fixed', delay: 1000 };

/** One attempt that ended without success, and what the job does next. */
export interface FailedAttempt {
  readonly row: HeldRow;
  readonly now: number;
  /** `row.attempts + 1`: the tries counted once this one is. */
  readonly attempts: number;
  /** The job's retry state before this attempt. */
  readonly prior: RetryState;
  /** Run again (after the backoff) when true; otherwise the job is done and goes to the DLQ. */
  readonly retry: boolean;
  /** Why the attempt ended, and so the reason of the DLQ entry when it was the last. */
  readonly reason: FailureReason;
  /** The lease expired before the processing deadline: counts toward `maxStalls`. */
  readonly stalled: boolean;
  readonly message: string;
  readonly stack?: string;
}

export type Settled = { readonly event: StoreEvent } & (
  | {
      readonly outcome: 'retried';
      /** The bell for the job: null when the backoff is longer than the transport can hold. */
      readonly ring: Ring | null;
    }
  | {
      readonly outcome: 'failed';
      /** `removeOnFail` deleted the row instead of leaving a DLQ entry. */
      readonly removed: boolean;
      /** The queue's DLQ limit, to enforce once the batch is written; null when no entry was written. */
      readonly dlqMaxEntries: number | null;
    }
);

/**
 * The one place an attempt that did not succeed is turned into a retry or a DLQ entry, shared by
 * `fail` (a worker's report) and recovery (a lease that expired), so both count an attempt, clear
 * `rung_at`, keep the attempt history and cap the DLQ the same way. The caller holds the row's
 * lock and has checked its fence; every write here bumps `version`.
 *
 * A retry moves the job to `delayed`, `prioritized` or `waiting` at `now + backoff` with its
 * lease and `rung_at` cleared, and returns the ring that makes the transport deliver a bell for it.
 * A last attempt writes the DLQ blob once: the row becomes `failed`, or is deleted when the job
 * asked for `removeOnFail`.
 */
export async function settleAttempt(
  tx: TransactionSQL,
  ctx: StoreContext,
  attempt: FailedAttempt,
  policyOf: (queue: string) => Promise<QueuePolicies>
): Promise<Settled> {
  const { row, now, attempts, reason, message } = attempt;
  const startedAt = row.started_at === null ? null : Number(row.started_at);
  const record: AttemptRecord = {
    attempt: attempts,
    startedAt,
    failedAt: now,
    reason,
    error: message,
    durationMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
  };
  const history = withAttempt(attempt.prior, record, attempt.stalled);
  const envelope = ctx.codec.decode(row.payload) as Envelope;

  if (attempt.retry) {
    const runAt = now + retryDelayMs(envelope.backoff ?? FALLBACK_BACKOFF, attempts, ctx.backoff);
    const state = initialState(runAt, now, row.priority);
    await tx`
      UPDATE qcloud_jobs
      SET state = ${state}, attempts = ${attempts}, run_at = ${runAt}, rung_at = NULL,
          started_at = NULL, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
          lease_renewals = 0, error = NULL, failure_reason = NULL,
          dlq_retry_state = ${ctx.codec.encode(history)}, version = version + 1
      WHERE namespace = ${ctx.namespace} AND id = ${row.id}`;
    return {
      outcome: 'retried',
      ring: ringFor(ctx.namespace, row.queue, row.id, runAt, now, ctx.ringWindowMs),
      event: {
        type: reason === 'explicit_fail' ? 'retried' : 'stalled',
        queue: row.queue,
        jobId: row.id,
        state,
        error: message,
      },
    };
  }

  const removed = envelope.removeOnFail === true;
  const policies = await policyOf(row.queue);
  if (removed) {
    await deleteJobRows(tx, ctx.namespace, [row.id]);
  } else {
    const blob: DlqBlob = {
      v: 1,
      enteredAt: now,
      reason,
      error: message,
      ...(attempt.stack !== undefined && { stack: attempt.stack }),
      attempts: history.attempts,
    };
    await tx`
      UPDATE qcloud_jobs
      SET state = 'failed', attempts = ${attempts}, completed_at = ${now}, rung_at = NULL,
          lease_owner = NULL, lease_token = NULL, lease_until = NULL, lease_renewals = 0,
          error = ${message}, failure_reason = ${reason}, dlq_entry = ${ctx.codec.encode(blob)},
          dlq_retry_state = NULL, version = version + 1
      WHERE namespace = ${ctx.namespace} AND id = ${row.id}`;
  }
  return {
    outcome: 'failed',
    removed,
    dlqMaxEntries: removed ? null : policies.maxEntries,
    event: {
      type: 'failed',
      queue: row.queue,
      jobId: row.id,
      state: 'failed',
      error: message,
      ...(removed && { removed: true as const }),
    },
  };
}

/** The retry state a row carries, decoded with the store's codec. */
export const retryStateOf = (ctx: StoreContext, row: HeldRow): RetryState =>
  decodeRetryState(ctx.codec, row.dlq_retry_state);
