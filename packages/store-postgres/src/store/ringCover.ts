import type { EnqueuedJob } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';

/**
 * Marks the jobs of `$4` (a JSON list of `{id, queue}`) as rung when their queue already has a
 * claimable job whose bell was rung in the last `$3` ms, with the time of that latest bell (not now:
 * a covered job must not extend the window it sits in, or a steady stream of adds would never ring
 * again, and its bell age is the covering bell's), and returns the ids it marked. Parameters:
 * namespace, now, cover window, the list. One probe per queue of the list, a backward range scan of
 * `qcloud_jobs_ring_idx`: `rung_at` in `(now - cover, now]` holds only recent bells, so a delayed
 * job pre-rung for the future (`rung_at` = its `run_at`) is outside it. The list goes in as one JSON text so the
 * statement has no array parameter.
 */
export const COVER_RINGS = `
  WITH due AS (
    SELECT id, queue FROM jsonb_to_recordset($4::text::jsonb) AS entry(id text, queue text)
  ), covered AS (
    SELECT asked.queue, bell.rung_at
    FROM (SELECT DISTINCT queue FROM due) AS asked
    CROSS JOIN LATERAL (
      SELECT live.rung_at FROM qcloud_jobs live
      WHERE live.namespace = $1 AND live.queue = asked.queue
        AND live.state IN ('waiting', 'prioritized')
        AND live.rung_at > $2::bigint - $3::bigint AND live.rung_at <= $2::bigint
      ORDER BY live.rung_at DESC LIMIT 1
    ) AS bell
  )
  UPDATE qcloud_jobs AS job SET rung_at = covered.rung_at
  FROM due JOIN covered USING (queue)
  WHERE job.namespace = $1 AND job.id = due.id
  RETURNING job.id`;

/**
 * Drops the ring of a new job whose queue is already covered by a recent bell (`ringCoverMs`), and
 * records the job as rung by that bell, so the tick does not ring it as a job that never was. A worker's claim
 * takes a batch and keeps claiming while the queue has more, so one live bell per window is enough
 * to wake it; the jobs it did not wake for are found by the tick's re-ring once their bell is
 * `reRingAfterMs` old, the same bound as a lost bell (DESIGN.md invariant 3). A job with a delay
 * (`dueInMs > 0`) keeps its ring: a bell for the future covers nothing now. Off at 0, the default.
 * Runs in the enqueue's transaction, after its inserts.
 */
export async function coverRings(
  ctx: StoreContext,
  tx: TransactionSQL,
  jobs: EnqueuedJob[],
  now: number
): Promise<EnqueuedJob[]> {
  if (ctx.ringCoverMs === 0) return jobs;
  const due = jobs.flatMap((job) =>
    job.created && job.ring?.dueInMs === 0 ? [{ id: job.id, queue: job.ring.bell.queue }] : []
  );
  if (due.length === 0) return jobs;
  const rows = await tx.unsafe<Array<{ id: string }>>(COVER_RINGS, [
    ctx.namespace,
    now,
    ctx.ringCoverMs,
    JSON.stringify(due),
  ]);
  const covered = new Set(rows.map((row) => row.id));
  return jobs.map((job) => (covered.has(job.id) ? { ...job, ring: null } : job));
}

/** The `ringCoverMs` option: a whole number of milliseconds, 0 (the default) for off. */
export function requestedRingCoverMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UnsupportedOptionError('ringCoverMs', 'must be a non-negative integer (ms)');
  }
  return value;
}
