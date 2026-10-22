import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { DEFAULT_DELIVERY_PAGE, MAX_DELIVERY_PAGE, STATUSES } from './webhookHistory';
import type { DeliveryRow } from './webhookRows';
import { DELIVERY_COLUMNS, deliveryNumber, deliveryOf } from './webhookRows';
import type { AllDeliveriesQuery, DeliveryPage, RetryFailedOptions } from './webhookTypes';

/**
 * What the console's Events screen reads across webhooks, and its bulk retry. A webhook's own history
 * and the retry of one delivery are in `webhookHistory.ts`. A delivery's `createdAt` is its event's
 * time (the partition key), so a time window prunes whole days.
 */

/** Most failed deliveries one bulk retry puts back. */
export const MAX_BULK_RETRY = 500;

const whole = (name: string, value: number | undefined, max: number): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UnsupportedOptionError(name, `must be an integer from 1 to ${max}`);
  }
  return value;
};

const time = (name: string, value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UnsupportedOptionError(name, 'must be a time in epoch milliseconds');
  }
  return value;
};

/** Deliveries of every webhook, newest first, a page at a time. */
export async function listAllDeliveries(
  ctx: StoreContext,
  query: AllDeliveriesQuery = {}
): Promise<DeliveryPage> {
  const limit = whole('limit', query.limit, MAX_DELIVERY_PAGE) ?? DEFAULT_DELIVERY_PAGE;
  if (query.status !== undefined && !STATUSES.includes(query.status)) {
    throw new UnsupportedOptionError('status', 'must be pending, sending, delivered or failed');
  }
  const since = time('since', query.since);
  const until = time('until', query.until);
  // Only what was asked for is in the statement, so a time window prunes partitions.
  const params: unknown[] = [ctx.namespace];
  const where = ['namespace = $1'];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.before !== undefined) add('id < ?', deliveryNumber('before', query.before));
  if (query.status !== undefined) add('status = ?', query.status);
  if (query.webhook !== undefined) add('webhook_id = ?', identifier('webhook', query.webhook));
  if (since !== undefined) add('created_at >= ?', since);
  if (until !== undefined) add('created_at < ?', until);
  params.push(limit + 1);
  return ctx.db.run('listAllDeliveries', async (sql) => {
    const rows = await sql.unsafe<DeliveryRow[]>(
      `SELECT ${DELIVERY_COLUMNS} FROM qcloud_deliveries
       WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    const items = rows.slice(0, limit).map(deliveryOf);
    return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
  });
}

/**
 * Puts a webhook's failed deliveries back to be sent again, newest first, at most `limit`, each with a
 * full budget of attempts (as `retryDelivery` does for one). Rows another transaction holds are left
 * for a later call, never waited for. Null when there is no such webhook, else how many went back.
 */
export async function retryFailedDeliveries(
  ctx: StoreContext,
  id: string,
  options: RetryFailedOptions = {}
): Promise<{ readonly retried: number } | null> {
  const key = identifier('id', id);
  const limit = whole('limit', options.limit, MAX_BULK_RETRY) ?? MAX_BULK_RETRY;
  const before = options.before === undefined ? null : deliveryNumber('before', options.before);
  return ctx.db.run('retryFailedDeliveries', (sql) =>
    runTransaction(sql, async (tx) => {
      const [hook] = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_webhooks WHERE namespace = ${ctx.namespace} AND id = ${key}`;
      if (!hook) return null;
      const now = await ctx.db.time.now(tx);
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `UPDATE qcloud_deliveries
         SET status = 'pending', next_attempt_at = $4, attempt_base = attempts, finished_at = NULL
         WHERE namespace = $1 AND id IN (
           SELECT id FROM qcloud_deliveries
           WHERE namespace = $1 AND webhook_id = $2 AND status = 'failed'
             AND ($3::bigint IS NULL OR id < $3::bigint)
           ORDER BY id DESC LIMIT $5 FOR UPDATE SKIP LOCKED)
         RETURNING id`,
        [ctx.namespace, key, before, now, limit]
      );
      return { retried: rows.length };
    })
  );
}
