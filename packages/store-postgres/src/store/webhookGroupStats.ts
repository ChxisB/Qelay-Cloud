import type { StoreContext } from './context';
import { checkedWindow } from './webhookStats';
import type {
  GroupBucket,
  GroupStatsQuery,
  WebhookGroupStat,
  WebhookGroupStats,
} from './webhookStatsTypes';

/**
 * The connections list's numbers: `webhookStats` for every webhook at once, counts and a trend and no latency
 * (the latency read opens each delivery's history, which a list of up to 100 webhooks should not). One grouped
 * count over the window of the deliveries' event times (the partition key, so only those days are read), and
 * one probe of the pending-delivery index per webhook for the backlog. Both answer from the same rows the
 * per-webhook read counts, so the numbers agree.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Group = Omit<Mutable<WebhookGroupStat>, 'buckets'> & { buckets: Array<Mutable<GroupBucket>> };

const num = (value: unknown): number => Number(value ?? 0);

export async function webhookGroupStats(
  ctx: StoreContext,
  query: GroupStatsQuery
): Promise<WebhookGroupStats> {
  const { buckets, bucketMs } = checkedWindow(query);
  const { since, until } = query;
  return ctx.db.run('webhookGroupStats', async (sql) => {
    const counts = await sql.unsafe<
      Array<{ webhook_id: string; bucket: string; status: string; n: string }>
    >(
      `SELECT webhook_id, (created_at - $2::bigint) / $4::bigint AS bucket, status, count(*) AS n
       FROM qcloud_deliveries
       WHERE namespace = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY 1, 2, 3`,
      [ctx.namespace, since, until, bucketMs]
    );
    // Every webhook is here, with what waits for it now: a webhook with no events in the window is all zeros.
    const routes = await sql.unsafe<Array<{ id: string; n: string; oldest: string | null }>>(
      `SELECT w.id, p.n, p.oldest
       FROM qcloud_webhooks w CROSS JOIN LATERAL (
         SELECT count(*) AS n, min(d.created_at) AS oldest FROM qcloud_deliveries d
         WHERE d.namespace = w.namespace AND d.webhook_id = w.id AND d.status IN ('pending', 'sending')) p
       WHERE w.namespace = $1
       ORDER BY w.id`,
      [ctx.namespace]
    );

    const groups = new Map<string, Group>();
    for (const route of routes) {
      groups.set(route.id, {
        webhookId: route.id,
        delivered: 0,
        failed: 0,
        pending: 0,
        failureRatio: null,
        backlog: num(route.n),
        oldestPendingAt: route.oldest === null ? null : Number(route.oldest),
        buckets: Array.from({ length: buckets }, (_, index) => ({
          from: since + index * bucketMs,
          delivered: 0,
          failed: 0,
          pending: 0,
        })),
      });
    }
    for (const row of counts) {
      // A delivery of a webhook deleted since the first read has no group: it is gone from the answer too.
      const group = groups.get(row.webhook_id);
      if (group === undefined) continue;
      const slice = group.buckets[Math.min(num(row.bucket), buckets - 1)]!;
      const n = num(row.n);
      const key = row.status === 'delivered' || row.status === 'failed' ? row.status : 'pending';
      slice[key] += n;
      group[key] += n;
    }
    for (const group of groups.values()) {
      const finished = group.delivered + group.failed;
      group.failureRatio = finished === 0 ? null : group.failed / finished;
    }
    return { since, until, bucketMs, groups: [...groups.values()] };
  });
}
