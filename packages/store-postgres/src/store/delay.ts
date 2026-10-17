import type { JobState } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';

/** Most delayed jobs one pass promotes, when the caller names no other number. */
export const DEFAULT_PROMOTE_LIMIT = 1000;

export interface PromotionReport {
  readonly promoted: number;
  /** More due jobs than the limit were found: another pass has work. */
  readonly more: boolean;
}

/**
 * Moves delayed jobs whose `run_at` has passed to `waiting` (priority 0) or `prioritized`, and
 * journals each as `promoted`. Adapted from Qelay's `promotion.ts` (see docs/PORTING.md).
 *
 * The state is cosmetic for claiming: a claim and every reader already treat a stored `delayed` row
 * past its `run_at` as ready (`effectiveState`), so a tick that never ran would not strand a job.
 * What promotion buys is an accurate stored state for the indexes and the panel. It keeps `run_at`,
 * so the job keeps its place in FIFO order, and it keeps `rung_at`: a job whose pre-ring is in
 * flight or delivered needs no second bell, and one that has none is found by `dueForRing`. Rings
 * are therefore the ring query's work alone, not this pass's.
 *
 * The due jobs are found a queue at a time through `qcloud_jobs_delayed_idx` (oldest due time first,
 * at most `limit` in all), then locked `FOR UPDATE SKIP LOCKED` and re-checked, so concurrent passes
 * promote disjoint sets and a job an operator just promoted or cancelled is not touched twice.
 */
export async function promoteDue(
  ctx: StoreContext,
  limit: number = DEFAULT_PROMOTE_LIMIT
): Promise<PromotionReport> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('promoteDue', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const ns = ctx.namespace;
      const found = await tx<Array<{ id: string }>>`
        WITH RECURSIVE queues(queue) AS (
          (SELECT queue FROM qcloud_jobs WHERE namespace = ${ns} AND state = 'delayed'
           ORDER BY queue LIMIT 1)
          UNION ALL
          SELECT (SELECT job.queue FROM qcloud_jobs job
                  WHERE job.namespace = ${ns} AND job.state = 'delayed' AND job.queue > queues.queue
                  ORDER BY job.queue LIMIT 1)
          FROM queues WHERE queues.queue IS NOT NULL
        )
        SELECT candidate.id
        FROM queues
        CROSS JOIN LATERAL (
          SELECT job.id, job.run_at FROM qcloud_jobs job
          WHERE job.namespace = ${ns} AND job.queue = queues.queue
            AND job.state = 'delayed' AND job.run_at <= ${now}
          ORDER BY job.run_at, job.id
          LIMIT ${cap + 1}
        ) candidate
        WHERE queues.queue IS NOT NULL
        ORDER BY candidate.run_at, candidate.id
        LIMIT ${cap + 1}`;
      if (found.length === 0) return { promoted: 0, more: false };
      const ids = found.slice(0, cap).map((row) => row.id);
      const locked = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_jobs
        WHERE namespace = ${ns} AND id = ANY(${tx.array(ids, 'TEXT')})
          AND state = 'delayed' AND run_at <= ${now}
        ORDER BY run_at, id
        FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return { promoted: 0, more: found.length > cap };
      const moved = await tx<Array<{ id: string; queue: string; state: JobState }>>`
        UPDATE qcloud_jobs
        SET state = CASE WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END,
            version = version + 1
        WHERE namespace = ${ns}
          AND id = ANY(${tx.array(
            locked.map((row) => row.id),
            'TEXT'
          )})
        RETURNING id, queue, state`;
      await ctx.recorder.record(
        tx,
        moved
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((row) => ({
            type: 'promoted' as const,
            queue: row.queue,
            jobId: row.id,
            state: row.state,
          })),
        now
      );
      return { promoted: moved.length, more: found.length > cap };
    })
  );
}
