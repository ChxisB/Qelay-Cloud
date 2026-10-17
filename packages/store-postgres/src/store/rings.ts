import type { RungEntry } from '@qelay-cloud/core';
import type { StoreContext } from './context';

/**
 * Records that the broker took these bells: `rung_at = now + deliverAfterMs`, only where the job
 * is still pending (waiting, prioritized or delayed, so a delayed job's pre-ring counts). A job
 * that was claimed, finished or removed in the meantime is left alone, and so is an id that does
 * not exist, so a late report cannot resurrect anything.
 *
 * Two entries for one job (two bells) record the earlier delivery. Calling it again with the same
 * entries and the same `now` changes nothing.
 */
export async function markRung(ctx: StoreContext, rung: readonly RungEntry[]): Promise<void> {
  if (rung.length === 0) return;
  const earliest = new Map<string, number>();
  for (const { jobId, deliverAfterMs } of rung) {
    const delay = Number.isFinite(deliverAfterMs) ? Math.max(0, Math.floor(deliverAfterMs)) : 0;
    earliest.set(jobId, Math.min(delay, earliest.get(jobId) ?? Number.POSITIVE_INFINITY));
  }
  await ctx.db.run('markRung', async (sql) => {
    const now = await ctx.db.time.now(sql);
    await sql`
      UPDATE qcloud_jobs AS job
      SET rung_at = ${now} + rung.deliver_after_ms
      FROM unnest(${sql.array([...earliest.keys()], 'TEXT')},
                  ${sql.array([...earliest.values()], 'BIGINT')}) AS rung(id, deliver_after_ms)
      WHERE job.namespace = ${ctx.namespace} AND job.id = rung.id
        AND job.state IN ('waiting', 'prioritized', 'delayed')`;
  });
}
