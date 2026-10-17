import type { Lease, Outcome } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { isWellFormedLease, leaseDeadline } from './leaseRules';
import { ringFor } from './state';

/**
 * Renewal and release of a held lease. Adapted from Qelay's `leaseRenewal.ts` and `leaseRelease.ts`
 * (see docs/PORTING.md). Both are one `UPDATE` fenced by the lease token and an unexpired lease:
 * the statement takes the row lock, and if a writer got there first it re-checks the fence against
 * the committed row, so a lease that was lost (expired, recovered, claimed by someone else) is
 * never touched. Neither is wrapped in the retry helper: a single-row `UPDATE` cannot deadlock
 * with another statement, and a replay would not be safe to assume (see the task 13 Result).
 */

/**
 * Extends the lease to `now + leaseMs`, never past the job's processing deadline
 * (`started_at + timeout`) and never shorter than it already is. A job already past that deadline
 * is not renewed: it timed out, and the tick recovers it.
 */
export async function heartbeat(ctx: StoreContext, lease: Lease): Promise<boolean> {
  if (!isWellFormedLease(lease)) return false;
  return ctx.db.run('heartbeat', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const until = leaseDeadline(now, ctx.leaseMs);
    const rows = await sql<{ id: string }[]>`
      UPDATE qcloud_jobs
      SET lease_until = CASE
            WHEN timeout IS NULL OR timeout = 0 THEN GREATEST(lease_until, ${until})
            ELSE LEAST(GREATEST(lease_until, ${until}), started_at + timeout)
          END,
          lease_renewals = lease_renewals + 1,
          version = version + 1
      WHERE namespace = ${ctx.namespace} AND id = ${lease.jobId}
        AND state = 'active' AND lease_token = ${lease.token} AND lease_until > ${now}
        AND (timeout IS NULL OR timeout = 0 OR started_at + timeout > ${now})
      RETURNING id`;
    return rows.length === 1;
  });
}

interface ReleasedRow {
  readonly id: string;
  readonly queue: string;
  readonly priority: number;
  readonly state: 'waiting' | 'prioritized';
  readonly run_at: number | string | bigint;
}

/**
 * Gives a held job back: claimable again at once, with its place in the queue (`run_at`, id) and
 * without counting an attempt. `rung_at` is cleared, and the returned ring is the bell for it.
 */
export async function release(ctx: StoreContext, lease: Lease): Promise<Outcome> {
  if (!isWellFormedLease(lease)) return { ok: false, rings: [] };
  return ctx.db.run('release', (sql) =>
    sql.begin(async (tx) => {
      const now = await ctx.db.time.now(tx);
      const rows = await tx<ReleasedRow[]>`
        UPDATE qcloud_jobs
        SET state = CASE WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END,
            run_at = LEAST(run_at, ${now}), started_at = NULL, lease_owner = NULL,
            lease_token = NULL, lease_until = NULL, lease_renewals = 0, rung_at = NULL,
            version = version + 1
        WHERE namespace = ${ctx.namespace} AND id = ${lease.jobId}
          AND state = 'active' AND lease_token = ${lease.token} AND lease_until > ${now}
        RETURNING id, queue, priority, state, run_at`;
      const row = rows[0];
      if (!row) return { ok: false, rings: [] };
      await ctx.recorder.record(
        tx,
        [{ type: 'released', queue: row.queue, jobId: row.id, state: row.state }],
        now
      );
      const ring = ringFor(
        ctx.namespace,
        row.queue,
        row.id,
        Number(row.run_at),
        now,
        ctx.ringWindowMs
      );
      return { ok: true, rings: ring === null ? [] : [ring] };
    })
  );
}
