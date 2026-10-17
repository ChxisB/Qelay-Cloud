import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';

export type MetricType = 'completed' | 'failed';

/** Fourteen days of one-minute buckets, upstream's `maxMetricDataPoints`. */
export const DEFAULT_MAX_METRIC_BUCKETS = 20_160;

const MINUTE_MS = 60_000;

/**
 * Adds counts of `type` to the queue's minute bucket and lifetime total, inside the caller's
 * transaction, so a metric is never written for a change that rolled back. Adapted from Qelay's
 * `metricWrites.ts` (see docs/PORTING.md). Rows are touched in queue order, so two batches cannot
 * deadlock on each other's queues. Buckets older than the retention (`maxMetricBuckets` minutes) are
 * pruned; with 0 only the totals are kept. The totals carry the latest minute's count (`prev_*`)
 * the way upstream's do.
 *
 * Call it last in the transaction: the rows are shared by every writer of the queue, and a lock
 * taken late is held for less time.
 */
export async function recordMetrics(
  tx: TransactionSQL,
  ctx: StoreContext,
  type: MetricType,
  counts: ReadonlyMap<string, number>,
  now: number
): Promise<void> {
  const additions = [...counts]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (additions.length === 0) return;
  const queues = tx.array(
    additions.map(([queue]) => queue),
    'TEXT'
  );
  const amounts = tx.array(
    additions.map(([, count]) => count),
    'INTEGER'
  );
  const minute = Math.floor(now / MINUTE_MS);
  const retention = ctx.maxMetricBuckets;
  await tx`
    DELETE FROM qcloud_metric_buckets
    WHERE namespace = ${ctx.namespace} AND queue = ANY(${queues}) AND metric_type = ${type}
      ${retention === 0 ? tx`` : tx`AND minute < ${minute - retention + 1}`}`;
  if (retention === 0) {
    await tx`
      INSERT INTO qcloud_metric_totals (namespace, queue, metric_type, total_count, prev_ts, prev_count)
      SELECT ${ctx.namespace}, batch.queue, ${type}, batch.addition, ${now}, batch.addition
      FROM unnest(${queues}, ${amounts}) AS batch(queue, addition)
      ORDER BY batch.queue
      ON CONFLICT (namespace, queue, metric_type) DO UPDATE SET
        total_count = qcloud_metric_totals.total_count + excluded.total_count,
        prev_ts = GREATEST(qcloud_metric_totals.prev_ts, excluded.prev_ts),
        prev_count = CASE
          WHEN excluded.prev_ts / 60000 > qcloud_metric_totals.prev_ts / 60000
            THEN excluded.prev_count
          WHEN excluded.prev_ts / 60000 = qcloud_metric_totals.prev_ts / 60000
            THEN qcloud_metric_totals.prev_count + excluded.prev_count
          ELSE qcloud_metric_totals.prev_count
        END`;
    return;
  }
  await tx`
    WITH incoming AS MATERIALIZED (
      SELECT batch.queue, batch.addition
      FROM unnest(${queues}, ${amounts}) AS batch(queue, addition)
      ORDER BY batch.queue
    ), buckets AS (
      INSERT INTO qcloud_metric_buckets (namespace, queue, metric_type, minute, count)
      SELECT ${ctx.namespace}, incoming.queue, ${type}, ${minute}, incoming.addition
      FROM incoming
      ORDER BY incoming.queue
      ON CONFLICT (namespace, queue, metric_type, minute)
      DO UPDATE SET count = qcloud_metric_buckets.count + excluded.count
      RETURNING queue, count
    )
    INSERT INTO qcloud_metric_totals (namespace, queue, metric_type, total_count, prev_ts, prev_count)
    SELECT ${ctx.namespace}, incoming.queue, ${type}, incoming.addition, ${now}, buckets.count
    FROM incoming
    JOIN buckets USING (queue)
    ORDER BY incoming.queue
    ON CONFLICT (namespace, queue, metric_type) DO UPDATE SET
      total_count = qcloud_metric_totals.total_count + excluded.total_count,
      prev_ts = GREATEST(qcloud_metric_totals.prev_ts, excluded.prev_ts),
      prev_count = CASE
        WHEN excluded.prev_ts / 60000 >= qcloud_metric_totals.prev_ts / 60000
          THEN excluded.prev_count
        ELSE qcloud_metric_totals.prev_count
      END`;
}
