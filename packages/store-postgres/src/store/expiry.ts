import type { JobState } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { releaseDeleted } from './flowResolve';
import { deleteJobRows } from './remove';
import { runTransaction } from './retry';

/** Most jobs one pass expires, when the caller names no other number. */
export const DEFAULT_EXPIRY_LIMIT = 1000;

export interface ExpiryReport {
  readonly expired: number;
  /** More jobs than the limit had expired: another pass has work. */
  readonly more: boolean;
}

/**
 * Deletes pending jobs whose TTL elapsed before anything claimed them (`created_at + ttl < now`,
 * oldest first), with their logs, flow failures and dependencies, and journals each as `removed`
 * with the error `Job TTL expired`. Adapted from Qelay's `expiry.ts` (see docs/PORTING.md). A job
 * that is active, finished or waiting for children is never expired, and a row another transaction
 * holds locked (a claim in flight) is skipped, so a job that is being claimed is not deleted. No
 * job option sets `ttl` today (D6), so only a row written with one is affected. The tick calls it
 * (task 15). No metric is counted: the job never ran.
 */
export async function expirePending(
  ctx: StoreContext,
  limit: number = DEFAULT_EXPIRY_LIMIT
): Promise<ExpiryReport> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('expirePending', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx<
        Array<{ id: string; queue: string; state: JobState; parent_id: string | null }>
      >`
        SELECT id, queue, state, parent_id FROM qcloud_jobs
        WHERE namespace = ${ctx.namespace} AND state IN ('waiting', 'prioritized', 'delayed')
          AND ttl IS NOT NULL AND created_at + ttl < ${now}
        ORDER BY created_at, id
        LIMIT ${cap + 1}
        FOR UPDATE SKIP LOCKED`;
      const rows = found.slice(0, cap);
      if (rows.length === 0) return { expired: 0, more: false };
      await deleteJobRows(
        tx,
        ctx.namespace,
        rows.map((row) => row.id)
      );
      await ctx.recorder.record(
        tx,
        rows.map((row) => ({
          type: 'removed' as const,
          queue: row.queue,
          jobId: row.id,
          state: row.state,
          error: 'Job TTL expired',
          removed: true as const,
        })),
        now
      );
      // A flow parent stops waiting for an expired child. Its bell comes from the tick's next pass.
      await releaseDeleted(
        ctx,
        tx,
        rows.map((row) => ({ id: row.id, parentId: row.parent_id })),
        now
      );
      return { expired: rows.length, more: found.length > cap };
    })
  );
}
