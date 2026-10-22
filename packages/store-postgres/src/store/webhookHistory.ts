import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type { DeliveryRow } from './webhookRows';
import { DELIVERY_COLUMNS, deliveryNumber, deliveryOf } from './webhookRows';
import type { DeliveryPage, DeliveryQuery, DeliveryRecord, RetryResult } from './webhookTypes';

/** The operator's history of a webhook: its deliveries, newest first, and putting a failed one back (`webhooks.ts` has the registry). */

export const DEFAULT_DELIVERY_PAGE = 50;
export const MAX_DELIVERY_PAGE = 200;

/** A webhook's deliveries, newest first. Null when there is no such webhook. */
export async function listDeliveries(
  ctx: StoreContext,
  id: string,
  query: DeliveryQuery = {}
): Promise<DeliveryPage | null> {
  const key = identifier('id', id);
  const limit = query.limit ?? DEFAULT_DELIVERY_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELIVERY_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_DELIVERY_PAGE}`);
  }
  const before = cursor(query.before);
  if (query.status !== undefined && !STATUSES.includes(query.status)) {
    throw new UnsupportedOptionError('status', 'must be pending, sending, delivered or failed');
  }
  return ctx.db.run('listDeliveries', async (sql) => {
    const [hook] = await sql<Array<{ id: string }>>`
      SELECT id FROM qcloud_webhooks WHERE namespace = ${ctx.namespace} AND id = ${key}`;
    if (!hook) return null;
    const rows = await sql.unsafe<DeliveryRow[]>(
      `SELECT ${DELIVERY_COLUMNS} FROM qcloud_deliveries
       WHERE namespace = $1 AND webhook_id = $2
         AND ($3::bigint IS NULL OR id < $3::bigint)
         AND ($4::text IS NULL OR status = $4::text)
       ORDER BY id DESC LIMIT $5`,
      [ctx.namespace, key, before, query.status ?? null, limit + 1]
    );
    const items = rows.slice(0, limit).map(deliveryOf);
    return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
  });
}

export const STATUSES: readonly string[] = ['pending', 'sending', 'delivered', 'failed'];

/** A delivery id from a caller, as the number it stands for; anything else is refused by name. */
function cursor(value: string | undefined): number | null {
  if (value === undefined) return null;
  return deliveryNumber('before', value);
}

/**
 * Puts a failed delivery back to be sent again, with a full budget of attempts (the attempt numbers
 * go on rising, so the history stays one list). `not_failed` for a delivery that is waiting, being
 * sent or already delivered: retrying those would send it twice.
 */
export async function retryDelivery(
  ctx: StoreContext,
  id: string,
  deliveryId: string
): Promise<RetryResult> {
  const key = identifier('id', id);
  const delivery = deliveryNumber('deliveryId', deliveryId);
  return ctx.db.run('retryDelivery', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const [row] = await tx.unsafe<DeliveryRow[]>(
        `UPDATE qcloud_deliveries
         SET status = 'pending', next_attempt_at = $4, attempt_base = attempts, finished_at = NULL
         WHERE namespace = $1 AND webhook_id = $2 AND id = $3 AND status = 'failed'
         RETURNING ${DELIVERY_COLUMNS}`,
        [ctx.namespace, key, delivery, now]
      );
      if (row) return { outcome: 'retried', delivery: deliveryOf(row) } as const;
      const [current] = await tx<Array<{ status: string }>>`
        SELECT status FROM qcloud_deliveries
        WHERE namespace = ${ctx.namespace} AND webhook_id = ${key} AND id = ${delivery}`;
      return current
        ? ({ outcome: 'not_failed', status: current.status as DeliveryRecord['status'] } as const)
        : ({ outcome: 'not_found' } as const);
    })
  );
}
