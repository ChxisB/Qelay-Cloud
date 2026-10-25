import type { StoreContext } from './context';
import { hasLiveConsumer } from './flowGuard';
import { removeAndRecord } from './remove';
import { runTransaction } from './retry';

/**
 * Completed jobs do not stay for ever: the tick deletes those that finished more than `completedRetentionMs` ago, with
 * their logs, journaling each as `removed` (the way `clean` and `removeOnComplete` do). Without it a queue that completes
 * millions of jobs a day keeps every row, and the table, its indexes and the vacuum grow with the age of the service.
 * Seven days by default; 0 turns it off. A job a live flow consumer still depends on stays (`flowGuard.ts`), a row another
 * transaction holds locked is skipped, and a completion record stays until `pruneCompletions` ages it out. Failed jobs are
 * not touched: they are the dead-letter queue's, with its own limits.
 *
 * shortcut: one window for every queue of the namespace, not a per-queue setting. A queue that needs its jobs longer
 * raises the window; one that wants them gone at once sets `removeOnComplete` on the job. Per-queue windows would be a
 * column on `qcloud_queue_state`.
 */
export const DEFAULT_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The oldest finished jobs past the window, across the namespace's queues, oldest first. That is the order of
 * `qcloud_jobs_completed_idx`, so the read stops at the limit and a pass with nothing old enough reads one entry.
 * Parameters: namespace, finished-by time, limit.
 */
export const COMPLETED_PAST_RETENTION = `
  SELECT job.id, job.queue FROM qcloud_jobs AS job
  WHERE job.namespace = $1 AND job.state = 'completed' AND job.completed_at <= $2
    AND NOT ${hasLiveConsumer('job')}
  ORDER BY job.completed_at, job.id
  LIMIT $3
  FOR UPDATE OF job SKIP LOCKED`;

export interface CompletedRetention {
  readonly removed: number;
  /** More jobs than the limit were old enough: another pass has work. */
  readonly more: boolean;
}

/** At most `limit` jobs. Safe from any number of processes (`SKIP LOCKED`). */
export async function pruneCompletedJobs(
  ctx: StoreContext,
  limit: number
): Promise<CompletedRetention> {
  if (ctx.completedRetentionMs === 0) return { removed: 0, more: false };
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('pruneCompletedJobs', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx.unsafe<Array<{ id: string; queue: string }>>(
        COMPLETED_PAST_RETENTION,
        [ctx.namespace, now - ctx.completedRetentionMs, cap + 1]
      );
      const rows = found.slice(0, cap);
      await removeAndRecord(tx, ctx, rows, 'completed', 'retention', now);
      return { removed: rows.length, more: found.length > cap };
    })
  );
}
