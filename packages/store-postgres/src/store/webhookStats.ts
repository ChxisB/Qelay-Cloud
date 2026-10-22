import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import type { StatsBucket, StatsQuery, WebhookStats } from './webhookTypes';

/**
 * The numbers of the console's Metrics and Home screens: deliveries by outcome, how long receivers
 * took, and what is waiting now. One read over a window of the deliveries' event times (the partition
 * key, so only those days are read). Latency comes from the attempts each delivery keeps in `history`
 * (a bounded list), so the window is capped and the work is bounded by the retention the tick enforces.
 * An attempt with no status (a refusal, a timeout, a queue route's job) has no receiver latency.
 */

export const MAX_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_STATS_BUCKETS = 24;
export const MAX_STATS_BUCKETS = 168;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const num = (value: unknown): number => Number(value ?? 0);
const orNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function checkedWindow(query: Pick<StatsQuery, 'since' | 'until' | 'buckets'>): {
  buckets: number;
  bucketMs: number;
} {
  const { since, until } = query;
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new UnsupportedOptionError('since', 'must be a time in epoch milliseconds');
  }
  if (!Number.isSafeInteger(until) || until <= since) {
    throw new UnsupportedOptionError('until', 'must be a time after since');
  }
  if (until - since > MAX_STATS_WINDOW_MS) {
    throw new UnsupportedOptionError('until', 'the window is at most 7 days');
  }
  const buckets = query.buckets ?? DEFAULT_STATS_BUCKETS;
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > MAX_STATS_BUCKETS) {
    throw new UnsupportedOptionError(
      'buckets',
      `must be an integer from 1 to ${MAX_STATS_BUCKETS}`
    );
  }
  return { buckets, bucketMs: Math.ceil((until - since) / buckets) };
}

export async function webhookStats(ctx: StoreContext, query: StatsQuery): Promise<WebhookStats> {
  const { buckets, bucketMs } = checkedWindow(query);
  const { since, until } = query;
  const hook = query.webhook === undefined ? null : identifier('webhook', query.webhook);
  return ctx.db.run('webhookStats', async (sql) => {
    const counts = await sql.unsafe<
      Array<{ bucket: string; status: string; n: string; attempts: string }>
    >(
      `SELECT (created_at - $2::bigint) / $4::bigint AS bucket, status, count(*) AS n, sum(attempts) AS attempts
       FROM qcloud_deliveries
       WHERE namespace = $1 AND created_at >= $2 AND created_at < $3
         AND ($5::text IS NULL OR webhook_id = $5::text)
       GROUP BY 1, 2`,
      [ctx.namespace, since, until, bucketMs, hook]
    );
    // One probe of the pending-delivery index per webhook (at most 100), as the claim does.
    const [waiting] = await sql.unsafe<Array<{ n: string | null; oldest: string | null }>>(
      `SELECT sum(p.n) AS n, min(p.oldest) AS oldest
       FROM qcloud_webhooks w CROSS JOIN LATERAL (
         SELECT count(*) AS n, min(d.created_at) AS oldest FROM qcloud_deliveries d
         WHERE d.namespace = w.namespace AND d.webhook_id = w.id AND d.status IN ('pending', 'sending')) p
       WHERE w.namespace = $1 AND ($2::text IS NULL OR w.id = $2::text)`,
      [ctx.namespace, hook]
    );
    // ROLLUP makes the row with a null bucket: all the window's attempts together.
    const latencies = await sql.unsafe<
      Array<{ bucket: string | null; avg: string | null; p95: string; max: string }>
    >(
      `SELECT (a.at - $2::bigint) / $4::bigint AS bucket, avg(a.ms) AS avg,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY a.ms) AS p95, max(a.ms) AS max
       FROM (SELECT (e ->> 'at')::bigint AS at, (e ->> 'durationMs')::bigint AS ms
             FROM qcloud_deliveries x CROSS JOIN LATERAL jsonb_array_elements(x.history) e
             WHERE x.namespace = $1 AND x.created_at >= $2 AND x.created_at < $3
               AND ($5::text IS NULL OR x.webhook_id = $5::text)
               AND e ->> 'statusCode' IS NOT NULL) a
       WHERE a.at >= $2 AND a.at < $3
       GROUP BY ROLLUP (1)`,
      [ctx.namespace, since, until, bucketMs, hook]
    );

    const slices: Array<Mutable<StatsBucket>> = Array.from({ length: buckets }, (_, index) => ({
      from: since + index * bucketMs,
      delivered: 0,
      failed: 0,
      pending: 0,
      avgLatencyMs: null,
      p95LatencyMs: null,
    }));
    let delivered = 0;
    let failed = 0;
    let pending = 0;
    let finishedAttempts = 0;
    for (const row of counts) {
      const slice = slices[Math.min(num(row.bucket), buckets - 1)]!;
      const n = num(row.n);
      if (row.status === 'delivered') {
        slice.delivered += n;
        delivered += n;
        finishedAttempts += num(row.attempts);
      } else if (row.status === 'failed') {
        slice.failed += n;
        failed += n;
        finishedAttempts += num(row.attempts);
      } else {
        slice.pending += n;
        pending += n;
      }
    }
    let latency: WebhookStats['latency'] = null;
    for (const row of latencies) {
      // With no attempts at all, ROLLUP still answers one row, of nulls.
      if (row.avg === null) continue;
      if (row.bucket === null) {
        latency = { avgMs: num(row.avg), p95Ms: num(row.p95), maxMs: num(row.max) };
        continue;
      }
      const slice = slices[Math.min(num(row.bucket), buckets - 1)]!;
      slice.avgLatencyMs = num(row.avg);
      slice.p95LatencyMs = num(row.p95);
    }
    const finished = delivered + failed;
    return {
      since,
      until,
      bucketMs,
      delivered,
      failed,
      pending,
      failureRatio: finished === 0 ? null : failed / finished,
      avgAttempts: finished === 0 ? null : finishedAttempts / finished,
      backlog: num(waiting?.n),
      oldestPendingAt: orNull(waiting?.oldest),
      latency,
      buckets: slices,
    };
  });
}
