/**
 * Version 2 DDL: the index the tick's re-ring needs. Version 1 left the ring query to
 * `qcloud_jobs_ring_idx`, whose `rung_at IS NULL` range also holds every delayed job that is not
 * due yet (a retry waiting out its backoff, a job scheduled for next week). A scan of that range
 * for the jobs that were never rung would read them all, with a heap fetch each, on every tick.
 * This partial index holds the pending jobs that have no bell, keyed by the time they become
 * claimable, so the tick reads only those due now or inside the transport's window and stops at
 * its cap. A job leaves it when `markRung` records its bell. See `store/ringQuery.ts`.
 */
export const TICK_STATEMENTS: readonly string[] = [
  `CREATE INDEX qcloud_jobs_unrung_idx
  ON qcloud_jobs(namespace, queue, run_at, id)
  WHERE rung_at IS NULL AND state IN ('waiting', 'prioritized', 'delayed')`,
];
