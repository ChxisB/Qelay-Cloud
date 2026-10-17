import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { CleanReport } from './clean';
import { cleanAge, cleanLimit } from './clean';
import type { StoreContext } from './context';
import { hasLiveConsumer } from './flowGuard';
import { identifier } from './prepare';
import { scanOf } from './readQueries';
import type { RemovedRow } from './remove';
import { removeEach } from './remove';
import { runTransaction } from './retry';

/**
 * `drain` and `cleanPending`: delete the jobs of one queue that have not started, in bounded calls.
 * Adapted from Qelay's `drainPostgresQueue` and the pending half of `clean` (see docs/PORTING.md).
 * Upstream also drains `waiting-children` jobs; here those are flow parents, and a parent is not
 * "not started work" to throw away in bulk: it goes through `remove`, one at a time, or with its
 * queue. A job another transaction has locked (a claim in flight) is skipped, and so is one a live
 * flow consumer depends on (`flowGuard.ts`). Each job is journaled as `removed` from the state a
 * reader would have shown, with `drained` or `cleaned` as the reason.
 */

export type PendingState = 'waiting' | 'prioritized' | 'delayed';

export interface PendingCleanOptions {
  readonly state: PendingState;
  /** Only jobs created at least this long ago (0: every job in the state). */
  readonly olderThanMs: number;
  /** At most this many in one call. Default 1,000, at most 10,000. */
  readonly limit?: number;
}

const PENDING_STATES: readonly unknown[] = ['waiting', 'prioritized', 'delayed'];

/**
 * The jobs to delete. A job's state is what a reader shows: a stored `delayed` row whose time has
 * come is `waiting`. The order is the one the index delivers for the state (`qcloud_jobs_ready_idx`
 * for the claimable states, `qcloud_jobs_delayed_idx` for delayed), so the read stops at the limit.
 * `state` null: every pending state, in claim order. Parameters: namespace, queue, now, created-by
 * time, limit.
 */
export function pendingCandidates(state: PendingState | null): string {
  const scan =
    state === null
      ? {
          where: `state IN ('waiting', 'prioritized', 'delayed')`,
          order: 'priority DESC, run_at, id',
        }
      : scanOf(state);
  return `
  SELECT job.id, job.queue,
         CASE WHEN job.run_at > $3 THEN 'delayed' WHEN job.priority > 0 THEN 'prioritized' ELSE 'waiting' END AS state
  FROM qcloud_jobs AS job
  WHERE job.namespace = $1 AND job.queue = $2 AND ${scan.where.replaceAll('{now}', '$3')}
    AND job.created_at <= $4
    AND NOT ${hasLiveConsumer('job')}
  ORDER BY ${scan.order}
  LIMIT $5
  FOR UPDATE OF job SKIP LOCKED`;
}

async function removePending(
  ctx: StoreContext,
  operation: string,
  queueName: string,
  state: PendingState | null,
  olderThanMs: number | null,
  limit: number,
  reason: string
): Promise<CleanReport> {
  const queue = identifier('queue', queueName);
  return ctx.db.run(operation, (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx.unsafe<RemovedRow[]>(pendingCandidates(state), [
        ctx.namespace,
        queue,
        now,
        olderThanMs === null ? Number.MAX_SAFE_INTEGER : now - olderThanMs,
        limit + 1,
      ]);
      const rows = found.slice(0, limit);
      await removeEach(tx, ctx, rows, reason, now);
      return { removed: rows.map((row) => row.id), more: found.length > limit };
    })
  );
}

/** Deletes the waiting, prioritized and delayed jobs of the queue, paused or not. */
export async function drainQueue(
  ctx: StoreContext,
  queue: string,
  options: { readonly limit?: number } = {}
): Promise<CleanReport> {
  const limit = cleanLimit(options.limit);
  return removePending(ctx, 'drain', queue, null, null, limit, 'drained');
}

/** Deletes the jobs of one pending state that were created long enough ago. */
export async function cleanPending(
  ctx: StoreContext,
  queue: string,
  options: PendingCleanOptions
): Promise<CleanReport> {
  if (!PENDING_STATES.includes(options.state)) {
    throw new UnsupportedOptionError('state', 'must be waiting, prioritized or delayed');
  }
  const olderThanMs = cleanAge(options.olderThanMs);
  const limit = cleanLimit(options.limit);
  return removePending(ctx, 'cleanPending', queue, options.state, olderThanMs, limit, 'cleaned');
}
