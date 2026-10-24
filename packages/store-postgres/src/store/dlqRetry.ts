import type {
  DlqRetryManyOptions,
  DlqRetryManyResult,
  DlqRetryResult,
  OperatorOptions,
  Ring,
} from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { StoreEvent } from './events';
import { hasLiveConsumer } from './flowGuard';
import { checkedVersion } from './operator';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type { FailureReason, RetryState } from './retryState';
import { EMPTY_RETRY_STATE, MAX_ATTEMPT_RECORDS } from './retryState';
import { initialState, ringFor } from './state';

/**
 * Retrying a dead-lettered job (D16): `retry-dlq`, the one legal move out of `failed`. The job goes
 * back to its ready state with no attempt used, no error and no entry, a new `version`, a `retried`
 * event and a bell for the caller to ring. The attempts that failed are kept as the job's history, so
 * its next failure shows every round. Flow members are refused (the flow's `retry-failed` is the way)
 * and so is a job whose dedup key a live job holds now. Nothing here retries by itself: a caller asks.
 */

/** Most entries one `retryDlqMany` call takes. */
export const MAX_DLQ_RETRY = 500;

const FAILURE_REASONS: readonly FailureReason[] = [
  'explicit_fail',
  'max_attempts_exceeded',
  'timeout',
  'stalled',
];

type Count = number | string | bigint;

/** True when the row `alias` stands for is a link of a flow. `alias` is written in this codebase, never input. */
const inFlow = (alias: string): string => `(
    ${alias}.parent_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM qcloud_jobs AS child
      WHERE child.namespace = ${alias}.namespace AND child.parent_id = ${alias}.id
    )
    OR ${hasLiveConsumer(alias)}
  )`;

/** True when another live job holds the dedup key of `alias`, which the live unique index would refuse. */
const keyTaken = (alias: string): string => `(
    ${alias}.unique_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM qcloud_jobs AS other
      WHERE other.namespace = ${alias}.namespace AND other.queue = ${alias}.queue
        AND other.unique_key = ${alias}.unique_key AND other.id <> ${alias}.id
        AND other.state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')
    )
  )`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What the retried job carries: the attempts of the entry it leaves. The stall count starts again,
 * because it is the allowance of a run (`maxStalls`), and the operator who retried wants a fresh one.
 */
function historyOf(ctx: StoreContext, entry: Uint8Array | null): RetryState {
  const blob = entry === null ? null : ctx.codec.decode(entry);
  if (!isRecord(blob) || !Array.isArray(blob.attempts)) return EMPTY_RETRY_STATE;
  const attempts = blob.attempts.filter(isRecord).slice(-MAX_ATTEMPT_RECORDS);
  return { attempts: attempts as unknown as RetryState['attempts'], stalls: 0 };
}

interface FailedRow {
  readonly id: string;
  readonly priority: number;
  readonly dlq_entry: Uint8Array | null;
  readonly unique_key: string | null;
}

interface LockedRow extends FailedRow {
  readonly state: string;
  readonly version: Count;
  readonly in_flow: boolean;
  readonly key_taken: boolean;
}

/** Puts one failed job back, as `ready`. Runs in the caller's transaction, with the row locked. */
async function reopen(
  tx: Parameters<Parameters<typeof runTransaction>[1]>[0],
  ctx: StoreContext,
  queue: string,
  row: FailedRow,
  now: number
): Promise<{ event: StoreEvent; ring: Ring | null }> {
  const state = initialState(now, now, row.priority);
  await tx`
    UPDATE qcloud_jobs
    SET state = ${state}, run_at = ${now}, rung_at = NULL, attempts = 0, started_at = NULL,
        completed_at = NULL, error = NULL, failure_reason = NULL, dlq_entry = NULL,
        dlq_retry_state = ${ctx.codec.encode(historyOf(ctx, row.dlq_entry))},
        version = version + 1
    WHERE namespace = ${ctx.namespace} AND id = ${row.id}`;
  return {
    event: { type: 'retried', queue, jobId: row.id, state },
    ring: ringFor(ctx.namespace, queue, row.id, now, now, ctx.ringWindowMs),
  };
}

/**
 * Retries one failed job of the queue. Locks the row first, so a purge that is deleting it makes this
 * answer `not_found` and a purge that comes after finds a waiting job and deletes nothing: exactly one
 * of the two wins. The refusals are answers: `not_found`, `version` (checked before the state, so a
 * caller that read the job earlier always learns it moved), `not_failed`, `flow_member`, `duplicate`.
 */
export async function retryDlq(
  ctx: StoreContext,
  queueName: string,
  jobId: string,
  options?: OperatorOptions
): Promise<DlqRetryResult> {
  const queue = identifier('queue', queueName);
  const id = identifier('jobId', jobId);
  const expected = checkedVersion(options);
  // shortcut: a dedup key taken by an enqueue that commits between the check and the update surfaces as the
  // driver's unique-violation error; the caller may call again, and it then answers `duplicate`.
  return ctx.db.run('retryDlq', (sql) =>
    runTransaction(sql, async (tx): Promise<DlqRetryResult> => {
      const [row] = await tx<LockedRow[]>`
        SELECT job.id, job.state, job.version, job.priority, job.dlq_entry, job.unique_key,
          ${tx.unsafe(inFlow('job'))} AS in_flow, ${tx.unsafe(keyTaken('job'))} AS key_taken
        FROM qcloud_jobs AS job
        WHERE job.namespace = ${ctx.namespace} AND job.queue = ${queue} AND job.id = ${id}
        FOR UPDATE OF job`;
      if (row === undefined) return { ok: false, reason: 'not_found' };
      if (expected !== undefined && Number(row.version) !== expected) {
        return { ok: false, reason: 'version' };
      }
      if (row.state !== 'failed') return { ok: false, reason: 'not_failed' };
      if (row.in_flow) return { ok: false, reason: 'flow_member' };
      if (row.key_taken) return { ok: false, reason: 'duplicate' };
      const now = await ctx.db.time.now(tx);
      const { event, ring } = await reopen(tx, ctx, queue, row, now);
      await ctx.recorder.record(tx, [event], now);
      return { ok: true, rings: ring ? [ring] : [] };
    })
  );
}

function checkedLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_DLQ_RETRY) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_DLQ_RETRY}`);
  }
  return limit;
}

function checkedReason(reason: unknown): string | null {
  if (reason === undefined) return null;
  if (typeof reason !== 'string' || !FAILURE_REASONS.includes(reason as FailureReason)) {
    throw new UnsupportedOptionError('reason', `must be one of ${FAILURE_REASONS.join(', ')}`);
  }
  return reason;
}

/**
 * Retries up to `limit` failed jobs of the queue, oldest failure first, in one transaction. A row
 * another transaction holds is skipped (it is being purged or retried there). Flow members and jobs
 * whose dedup key is taken are left alone and are not counted in `remaining`, so a caller that repeats
 * the call until `remaining` is 0 always ends.
 */
export async function retryDlqMany(
  ctx: StoreContext,
  queueName: string,
  options: DlqRetryManyOptions
): Promise<DlqRetryManyResult> {
  const queue = identifier('queue', queueName);
  const limit = checkedLimit(options.limit);
  const reason = checkedReason(options.reason);
  return ctx.db.run('retryDlqMany', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const rows = await tx<FailedRow[]>`
        SELECT job.id, job.priority, job.dlq_entry, job.unique_key FROM qcloud_jobs AS job
        WHERE job.namespace = ${ctx.namespace} AND job.queue = ${queue} AND job.state = 'failed'
          AND (${reason}::text IS NULL OR job.failure_reason = ${reason})
          AND NOT ${tx.unsafe(inFlow('job'))} AND NOT ${tx.unsafe(keyTaken('job'))}
        ORDER BY job.completed_at ASC NULLS FIRST, job.id ASC
        LIMIT ${limit}
        FOR UPDATE OF job SKIP LOCKED`;
      const events: StoreEvent[] = [];
      const rings: Ring[] = [];
      const keys = new Set<string>();
      const retried: string[] = [];
      for (const row of rows) {
        // Two failed jobs can share a dedup key (the first one's failure freed it): the oldest goes back, the
        // other is a `duplicate` from then on and a later call leaves it alone.
        if (row.unique_key !== null && keys.has(row.unique_key)) continue;
        if (row.unique_key !== null) keys.add(row.unique_key);
        const { event, ring } = await reopen(tx, ctx, queue, row, now);
        events.push(event);
        retried.push(row.id);
        if (ring) rings.push(ring);
      }
      await ctx.recorder.record(tx, events, now);
      const [left] = await tx<{ total: Count }[]>`
        SELECT count(*)::bigint AS total FROM qcloud_jobs AS job
        WHERE job.namespace = ${ctx.namespace} AND job.queue = ${queue} AND job.state = 'failed'
          AND (${reason}::text IS NULL OR job.failure_reason = ${reason})
          AND NOT ${tx.unsafe(inFlow('job'))} AND NOT ${tx.unsafe(keyTaken('job'))}`;
      return { retried, remaining: Number(left!.total), rings };
    })
  );
}
