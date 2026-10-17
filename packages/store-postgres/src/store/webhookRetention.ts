import type { StoreContext } from './context';
import { runTransaction } from './retry';

/**
 * How long past its due time a delivery may stay undelivered before the tick gives up on it (for a
 * claim nobody answered, past its lease), and how long finished ones (delivered or failed) stay
 * readable in the history. Both count from the delivery's own times, so a backlog behind a slow or
 * disabled receiver is bounded.
 */
export const WEBHOOK_DELIVERY_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_DELIVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export const EXPIRED_ERROR = 'expired: not delivered within 24 hours';

export interface WebhookRetention {
  /** Live deliveries failed for being too old. */
  readonly expired: number;
  /** Finished deliveries deleted for being too old. */
  readonly deleted: number;
  /** A cap was reached: another pass has work. */
  readonly more: boolean;
}

/**
 * Database-only upkeep, run by the tick: fails deliveries that have waited longer than
 * `WEBHOOK_DELIVERY_EXPIRY_MS` past due and deletes finished ones older than `WEBHOOK_DELIVERY_KEEP_MS`.
 * At most `limit` of each. Safe from any number of processes: a webhook the sender is working on is
 * left for the next pass (`SKIP LOCKED`).
 */
export async function pruneWebhookDeliveries(
  ctx: StoreContext,
  limit: number
): Promise<WebhookRetention> {
  const expired = await ctx.db.run('expireWebhookDeliveries', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const cutoff = now - WEBHOOK_DELIVERY_EXPIRY_MS;
      // Webhook rows first (the order the claim uses), then their stale deliveries.
      const hooks = await tx<Array<{ id: string }>>`
        SELECT w.id FROM qcloud_webhooks w
        WHERE w.namespace = ${ctx.namespace}
          AND EXISTS (
            SELECT 1 FROM qcloud_webhook_deliveries d
            WHERE d.namespace = ${ctx.namespace} AND d.webhook_id = w.id
              AND d.status IN ('pending', 'sending') AND d.next_attempt_at < ${cutoff})
        ORDER BY w.id
        FOR NO KEY UPDATE OF w SKIP LOCKED`;
      if (hooks.length === 0) return 0;
      const rows = await tx<Array<{ webhook_id: string }>>`
        UPDATE qcloud_webhook_deliveries d
        SET status = 'failed', finished_at = ${now}, last_error = ${EXPIRED_ERROR}
        WHERE d.id IN (
          SELECT x.id FROM qcloud_webhook_deliveries x
          WHERE x.namespace = ${ctx.namespace}
            AND x.webhook_id = ANY(${tx.array(
              hooks.map((hook) => hook.id),
              'TEXT'
            )})
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at < ${cutoff}
          ORDER BY x.next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        RETURNING d.webhook_id`;
      const perHook = new Map<string, number>();
      for (const row of rows) perHook.set(row.webhook_id, (perHook.get(row.webhook_id) ?? 0) + 1);
      if (perHook.size > 0) {
        await tx`
          UPDATE qcloud_webhooks w SET failure_count = w.failure_count + c.n
          FROM unnest(${tx.array([...perHook.keys()], 'TEXT')}, ${tx.array(
            [...perHook.values()],
            'INTEGER'
          )}) AS c(id, n)
          WHERE w.namespace = ${ctx.namespace} AND w.id = c.id`;
      }
      return rows.length;
    })
  );
  const deleted = await ctx.db.run('deleteWebhookDeliveries', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql<Array<{ id: number | string }>>`
      DELETE FROM qcloud_webhook_deliveries
      WHERE id IN (
        SELECT id FROM qcloud_webhook_deliveries
        WHERE namespace = ${ctx.namespace} AND status IN ('delivered', 'failed')
          AND finished_at < ${now - WEBHOOK_DELIVERY_KEEP_MS}
        ORDER BY finished_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.length;
  });
  return {
    expired,
    deleted,
    more: expired >= limit || deleted >= limit,
  };
}
