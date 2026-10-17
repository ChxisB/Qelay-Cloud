import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { hasLiveConsumer } from './flowGuard';
import { identifier } from './prepare';
import { removeAndRecord } from './remove';
import { runTransaction } from './retry';

/**
 * `clean`: deletes the finished jobs of one queue that finished long enough ago. Adapted from
 * Qelay's `cleanPostgresQueue` (see docs/PORTING.md). Only `completed` and `failed` jobs: cleaning
 * pending jobs, draining and obliterating are `store.control` (`pendingClean.ts`, `queueControl.ts`),
 * which the Control API fences with a confirmation (task 31). A job another transaction holds locked
 * is skipped, and so is one a live flow consumer still depends on (`flowGuard.ts`). Each job is journaled as `removed`;
 * its completion record stays, as `removeOnComplete` leaves it, until `pruneCompletions` ages it out.
 */

export const DEFAULT_CLEAN_LIMIT = 1_000;
export const MAX_CLEAN_LIMIT = 10_000;

/**
 * The jobs to delete, oldest created first: the order the state index delivers, so the read stops
 * at the limit. Parameters: namespace, queue, state, finished-by time, limit.
 */
export const CLEAN_CANDIDATES = `
  SELECT job.id, job.queue FROM qcloud_jobs AS job
  WHERE job.namespace = $1 AND job.queue = $2 AND job.state = $3 AND job.completed_at <= $4
    AND NOT ${hasLiveConsumer('job')}
  ORDER BY job.created_at, job.id
  LIMIT $5
  FOR UPDATE OF job SKIP LOCKED`;

/** A call's limit: an integer from 1 to `MAX_CLEAN_LIMIT`, default `DEFAULT_CLEAN_LIMIT`. */
export function cleanLimit(limit: number | undefined): number {
  const cap = limit ?? DEFAULT_CLEAN_LIMIT;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_CLEAN_LIMIT) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_CLEAN_LIMIT}`);
  }
  return cap;
}

/** A call's minimum age: a non-negative integer number of milliseconds. */
export function cleanAge(olderThanMs: number): number {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new UnsupportedOptionError('olderThanMs', 'must be a non-negative integer');
  }
  return olderThanMs;
}

export type CleanState = 'completed' | 'failed';

export interface CleanOptions {
  readonly state: CleanState;
  /** Only jobs that finished at least this long ago (0: every finished job). */
  readonly olderThanMs: number;
  /** At most this many in one call. Default `DEFAULT_CLEAN_LIMIT`, at most `MAX_CLEAN_LIMIT`. */
  readonly limit?: number;
}

export interface CleanReport {
  /** The ids deleted, oldest created first. */
  readonly removed: readonly string[];
  /** More jobs than the limit were eligible: another call has work. */
  readonly more: boolean;
}

export async function cleanJobs(
  ctx: StoreContext,
  queueName: string,
  options: CleanOptions
): Promise<CleanReport> {
  const queue = identifier('queue', queueName);
  if (options.state !== 'completed' && options.state !== 'failed') {
    throw new UnsupportedOptionError('state', 'must be completed or failed');
  }
  const olderThanMs = cleanAge(options.olderThanMs);
  const cap = cleanLimit(options.limit);
  return ctx.db.run('cleanJobs', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx.unsafe<Array<{ id: string; queue: string }>>(CLEAN_CANDIDATES, [
        ctx.namespace,
        queue,
        options.state,
        now - olderThanMs,
        cap + 1,
      ]);
      const rows = found.slice(0, cap);
      await removeAndRecord(tx, ctx, rows, options.state, 'cleaned', now);
      return { removed: rows.map((row) => row.id), more: found.length > cap };
    })
  );
}
