import type { StoreContext } from './context';

const MINUTE_MS = 60_000;

/**
 * Minute buckets older than the cut, at most `$3`. Parameters: namespace, cut minute (a bucket
 * below it goes), limit. One index range per queue and type, found through the totals (every bucket
 * has a totals row: they are written together), so a pass costs a probe per queue and no scan of the
 * table. Rows are taken `FOR UPDATE SKIP LOCKED`; a writer only touches the current minute.
 */
export const PRUNE_METRIC_BUCKETS = `
  WITH doomed AS (
    SELECT bucket.queue, bucket.metric_type, bucket.minute
    FROM qcloud_metric_totals AS total
    JOIN qcloud_metric_buckets AS bucket
      ON bucket.namespace = total.namespace AND bucket.queue = total.queue
        AND bucket.metric_type = total.metric_type
    WHERE total.namespace = $1 AND bucket.minute < $2
    LIMIT $3
    FOR UPDATE OF bucket SKIP LOCKED
  )
  DELETE FROM qcloud_metric_buckets AS bucket USING doomed
  WHERE bucket.namespace = $1 AND bucket.queue = doomed.queue
    AND bucket.metric_type = doomed.metric_type AND bucket.minute = doomed.minute`;

/**
 * Deletes the minute buckets past `maxMetricBuckets` minutes, at most `limit`; with 0 every bucket
 * goes and only the totals are kept. A step of `tick`: `recordMetrics` used to do it on every write,
 * which put a delete and a lock on the hot rows of every complete. `throughput` clamps its range to
 * the same window, so a bucket the tick has not reached yet is not shown. The delete is the one
 * `recordMetrics` ported from Qelay, moved here (see docs/PORTING.md).
 */
export async function pruneMetricBuckets(
  ctx: StoreContext,
  limit: number
): Promise<{ readonly removed: number; readonly more: boolean }> {
  const retention = ctx.maxMetricBuckets;
  return ctx.db.run('pruneMetricBuckets', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const cut =
      retention === 0 ? Number.MAX_SAFE_INTEGER : Math.floor(now / MINUTE_MS) - retention + 1;
    const rows = await sql.unsafe<unknown[]>(`${PRUNE_METRIC_BUCKETS} RETURNING 1`, [
      ctx.namespace,
      cut,
      limit,
    ]);
    return { removed: rows.length, more: rows.length >= limit };
  });
}
