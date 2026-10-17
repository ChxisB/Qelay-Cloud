import { hasClaimableGroup } from './claimSelect';
import type { StoreContext } from './context';
import { COUNTS_BY_STATE } from './readQueries';
import type { StateTotal } from './reads';
import { stateCounts } from './reads';

/**
 * What the local transport asks of the store: "is anything claimable?" on every poll, and the
 * numbers behind `DeliveryTransport.stats`. A transport that has a broker reads the broker instead.
 */

export interface QueueSnapshot {
  /** Claimable now: waiting and prioritized jobs, and delayed ones whose time has passed. */
  readonly ready: number;
  /** Pending with `run_at` still ahead. */
  readonly delayed: number;
  readonly active: number;
  /** Jobs in the failed state, which is the queue's DLQ. */
  readonly failed: number;
  /** Time since the oldest claimable job became claimable (its `run_at`), null when none is. */
  readonly oldestReadyAgeMs: number | null;
  /** The database's time the numbers describe. */
  readonly observedAt: number;
}

export interface DoorbellApi {
  /**
   * Whether a claim of this queue could find a job now: an unpaused queue with a pending job whose
   * `run_at` has passed, grouped or not. It does not look at the rate or concurrency limits, so a
   * limited queue can say yes and the claim find nothing: that is an empty claim, which is cheap and
   * is how a rate window that reopens is noticed. It costs what the claim's own select costs
   * (one index probe per kind of job) and takes no lock.
   */
  hasClaimable(queue: string): Promise<boolean>;
  /**
   * The queue's counts and the age of its oldest claimable job. The age is a scan of the queue's
   * claimable entries in `qcloud_jobs_ready_idx` (an index-only scan, but not a bounded one): it is
   * a dashboard read, not a hot path.
   */
  snapshot(queue: string): Promise<QueueSnapshot>;
}

export const doorbellApi = (ctx: StoreContext): DoorbellApi => ({
  hasClaimable: (queue) => hasClaimable(ctx, queue),
  snapshot: (queue) => snapshot(ctx, queue),
});

/**
 * One row `(claimable)`: an unpaused queue with an ungrouped pending job whose `run_at` has passed.
 * Parameters: namespace, queue, now. The selects are the claim's own, ordered and limited to one
 * row, so the planner reads `qcloud_jobs_ready_idx` and `qcloud_jobs_lifo_ready_idx` in claim order
 * and stops at the first match; a bare `EXISTS` lets it choose a sequential scan, which is cheap on
 * a queue with a backlog and reads the whole table on one without. The text is exported so the plan
 * test runs the same string.
 */
export const READY_PROBE = `
  SELECT (
    EXISTS (SELECT 1 FROM (
              SELECT 1 FROM qcloud_jobs
              WHERE namespace = $1 AND queue = $2 AND group_id IS NULL AND NOT lifo
                AND state IN ('waiting', 'prioritized', 'delayed') AND run_at <= $3
              ORDER BY priority DESC, run_at, id LIMIT 1) fifo)
    OR EXISTS (SELECT 1 FROM (
                 SELECT 1 FROM qcloud_jobs
                 WHERE namespace = $1 AND queue = $2 AND group_id IS NULL AND lifo
                   AND state IN ('waiting', 'prioritized', 'delayed') AND run_at <= $3
                 ORDER BY priority DESC, id DESC LIMIT 1) lifo)
  ) AND NOT EXISTS (SELECT 1 FROM qcloud_queue_state
                    WHERE namespace = $1 AND queue = $2 AND paused) AS claimable`;

/** One row `(oldest)`: the smallest `run_at` of a claimable job, null when none. Parameters: namespace, queue, now. */
export const OLDEST_READY = `
  SELECT min(run_at) AS oldest FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND state IN ('waiting', 'prioritized', 'delayed') AND run_at <= $3`;

async function hasClaimable(ctx: StoreContext, queue: string): Promise<boolean> {
  return ctx.db.run('hasClaimable', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const ns = ctx.namespace;
    const [row] = await sql.unsafe<{ claimable: boolean }[]>(READY_PROBE, [ns, queue, now]);
    if (row!.claimable) return true;
    const [state] = await sql<{ paused: boolean }[]>`
      SELECT paused FROM qcloud_queue_state WHERE namespace = ${ns} AND queue = ${queue}`;
    if (state?.paused) return false;
    return hasClaimableGroup(sql, ns, queue, now);
  });
}

async function snapshot(ctx: StoreContext, queue: string): Promise<QueueSnapshot> {
  return ctx.db.run('queueSnapshot', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const totals = stateCounts(
      await sql.unsafe<StateTotal[]>(COUNTS_BY_STATE, [ctx.namespace, queue, now])
    );
    const [oldest] = await sql.unsafe<{ oldest: number | string | bigint | null }[]>(OLDEST_READY, [
      ctx.namespace,
      queue,
      now,
    ]);
    return {
      ready: totals.waiting + totals.prioritized,
      delayed: totals.delayed,
      active: totals.active,
      failed: totals.failed,
      oldestReadyAgeMs: oldest?.oldest == null ? null : Math.max(0, now - Number(oldest.oldest)),
      observedAt: now,
    };
  });
}
