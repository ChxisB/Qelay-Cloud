import type { StoreContext } from './context';
import { runTransaction } from './retry';

/**
 * Group scheduler state that nothing needs any more. Adapted from Qelay's
 * `prunePostgresGroupStates` (see docs/PORTING.md). A group row keeps a rotation position
 * (`last_served`), its own limits and pause, and the state of its rate window. Once a group has no
 * live job (waiting, prioritized, delayed or active; a job waiting for children cannot be claimed,
 * and `ensureGroupStates` gives its group a position when it can):
 *
 * - its rotation position goes: the next job it gets is given a new one (`ensureGroupStates`);
 * - the row goes too, unless it carries something a person set (a limit, a pause, a manual rate
 *   limit still running) or a rate window that has not run out.
 *
 * Rows are taken `FOR UPDATE SKIP LOCKED`, so a claim that holds a group is not waited for, and a
 * group that gets a job after the read is not deleted (the delete checks again).
 */

export const DEFAULT_GROUP_PRUNE_LIMIT = 1_000;

/**
 * Groups with no live job that have a position to drop or nothing to keep. Parameters: namespace,
 * now, limit. The two live checks are two reads because each matches one partial index
 * (`qcloud_jobs_group_ready_idx`, `qcloud_jobs_group_active_idx`): one check over all four states
 * matches neither.
 */
export const IDLE_GROUPS = `
  SELECT groups.queue, groups.group_id FROM qcloud_group_state AS groups
  WHERE groups.namespace = $1
    AND NOT EXISTS (
      SELECT 1 FROM qcloud_jobs AS job
      WHERE job.namespace = groups.namespace AND job.queue = groups.queue
        AND job.group_id = groups.group_id AND job.state IN ('waiting', 'prioritized', 'delayed')
    )
    AND NOT EXISTS (
      SELECT 1 FROM qcloud_jobs AS job
      WHERE job.namespace = groups.namespace AND job.queue = groups.queue
        AND job.group_id = groups.group_id AND job.state = 'active'
    )
    AND (
      groups.last_served IS NOT NULL
      OR (
        groups.rate_limit IS NULL AND groups.rate_duration_ms IS NULL
        AND groups.concurrency_limit IS NULL AND groups.paused = FALSE
        AND (groups.manual_rate_limit_until IS NULL OR groups.manual_rate_limit_until <= $2)
        AND (
          groups.rate_window_started_at IS NULL
          OR (
            groups.rate_effective_duration_ms IS NOT NULL
            AND groups.rate_window_started_at + groups.rate_effective_duration_ms <= $2
          )
        )
      )
    )
  ORDER BY groups.queue, groups.group_id
  LIMIT $3
  FOR UPDATE OF groups SKIP LOCKED`;

export interface GroupPrune {
  /** Group rows deleted. A row that only lost its rotation position is not counted. */
  readonly removed: number;
  /** More idle groups than the limit: another sweep has work. */
  readonly more: boolean;
}

export async function pruneGroupStates(
  ctx: StoreContext,
  limit: number = DEFAULT_GROUP_PRUNE_LIMIT
): Promise<GroupPrune> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('pruneGroupStates', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const idle = await tx.unsafe<Array<{ queue: string; group_id: string }>>(IDLE_GROUPS, [
        ctx.namespace,
        now,
        cap + 1,
      ]);
      const rows = idle.slice(0, cap);
      if (rows.length === 0) return { removed: 0, more: false };
      const queues = tx.array(
        rows.map((row) => row.queue),
        'TEXT'
      );
      const groupIds = tx.array(
        rows.map((row) => row.group_id),
        'TEXT'
      );
      await tx`
        UPDATE qcloud_group_state AS groups SET last_served = NULL
        FROM unnest(${queues}, ${groupIds}) AS target(queue, group_id)
        WHERE groups.namespace = ${ctx.namespace}
          AND groups.queue = target.queue AND groups.group_id = target.group_id`;
      const deleted = await tx<Array<{ group_id: string }>>`
        DELETE FROM qcloud_group_state AS groups
        USING unnest(${queues}, ${groupIds}) AS target(queue, group_id)
        WHERE groups.namespace = ${ctx.namespace}
          AND groups.queue = target.queue AND groups.group_id = target.group_id
          AND groups.rate_limit IS NULL AND groups.rate_duration_ms IS NULL
          AND groups.concurrency_limit IS NULL AND groups.paused = FALSE
          AND (groups.manual_rate_limit_until IS NULL OR groups.manual_rate_limit_until <= ${now})
          AND (
            groups.rate_window_started_at IS NULL
            OR (
              groups.rate_effective_duration_ms IS NOT NULL
              AND groups.rate_window_started_at + groups.rate_effective_duration_ms <= ${now}
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM qcloud_jobs AS job
            WHERE job.namespace = groups.namespace AND job.queue = groups.queue
              AND job.group_id = groups.group_id
              AND job.state IN ('waiting', 'prioritized', 'delayed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM qcloud_jobs AS job
            WHERE job.namespace = groups.namespace AND job.queue = groups.queue
              AND job.group_id = groups.group_id AND job.state = 'active'
          )
        RETURNING groups.group_id`;
      return { removed: deleted.length, more: idle.length > cap };
    })
  );
}
