import type { StoreContext } from './context';
import { runTransaction } from './retry';

/**
 * Completion records: one per job that completed (`complete.ts`), kept when the job row goes
 * (`removeOnComplete`, `clean`), because they say "this job finished", which a flow consumer that
 * is admitted later still needs. The records of jobs that no longer exist are bounded here. Adapted
 * from Qelay's `prunePostgresCompletionTombstones` (see docs/PORTING.md).
 *
 * A record is deleted when all of these hold: it is older than the newest `maxCompletedJobs`
 * completions of the namespace; no job row has its id; no live job waits on it as a dependency. The
 * cut is one index-only read of `qcloud_completions_recent_idx` (the Nth newest entry), so a sweep
 * costs about `maxCompletedJobs` index entries when the table is over the limit, and the table's
 * own size when it is not. Upstream counted only the records without a job and so kept N of them;
 * this keeps the newest N completions whether or not their jobs remain, which bounds the same
 * table and needs no scan of job rows to count.
 *
 * Rows are taken `FOR UPDATE SKIP LOCKED`. Whatever relies on a completion record to admit a flow
 * consumer must lock the record `FOR SHARE` in its own transaction: this sweep then skips it, and
 * cannot delete evidence the admission is reading (task 50). No event is journaled: the records
 * are not jobs, and no reader follows them.
 */

export const DEFAULT_MAX_COMPLETED_JOBS = 50_000;
export const DEFAULT_COMPLETION_PRUNE_LIMIT = 1_000;

/** The newest completion that is past the keep limit. Parameters: namespace, how many to keep. */
export const COMPLETION_CUT = `
  SELECT completed_at, job_id FROM qcloud_completions
  WHERE namespace = $1
  ORDER BY completed_at DESC, job_id DESC
  OFFSET $2 LIMIT 1`;

/**
 * Records at or before the cut that nothing needs, oldest first. Parameters: namespace, the cut's
 * time and job id, limit.
 */
export const COMPLETION_CANDIDATES = `
  SELECT completion.job_id FROM qcloud_completions AS completion
  WHERE completion.namespace = $1
    AND (completion.completed_at, completion.job_id) <= ($2::bigint, $3)
    AND NOT EXISTS (
      SELECT 1 FROM qcloud_jobs AS retained
      WHERE retained.namespace = completion.namespace AND retained.id = completion.job_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM qcloud_dependencies AS dependency
      JOIN qcloud_jobs AS consumer
        ON consumer.namespace = dependency.namespace AND consumer.id = dependency.job_id
      WHERE dependency.namespace = completion.namespace
        AND dependency.dependency_id = completion.job_id
        AND consumer.state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')
    )
  ORDER BY completion.completed_at, completion.job_id
  LIMIT $4
  FOR UPDATE OF completion SKIP LOCKED`;

export interface CompletionPrune {
  readonly removed: number;
  /** More records than the limit were eligible: another sweep has work. */
  readonly more: boolean;
}

export async function pruneCompletions(
  ctx: StoreContext,
  limit: number = DEFAULT_COMPLETION_PRUNE_LIMIT
): Promise<CompletionPrune> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('pruneCompletions', (sql) =>
    runTransaction(sql, async (tx) => {
      const [cut] = await tx.unsafe<
        Array<{ completed_at: number | string | bigint; job_id: string }>
      >(COMPLETION_CUT, [ctx.namespace, ctx.maxCompletedJobs]);
      if (!cut) return { removed: 0, more: false };
      const found = await tx.unsafe<Array<{ job_id: string }>>(COMPLETION_CANDIDATES, [
        ctx.namespace,
        cut.completed_at,
        cut.job_id,
        cap + 1,
      ]);
      const ids = found.slice(0, cap).map((row) => row.job_id);
      if (ids.length > 0) {
        await tx`
          DELETE FROM qcloud_completions
          WHERE namespace = ${ctx.namespace} AND job_id = ANY(${tx.array(ids, 'TEXT')})`;
      }
      return { removed: ids.length, more: found.length > cap };
    })
  );
}
