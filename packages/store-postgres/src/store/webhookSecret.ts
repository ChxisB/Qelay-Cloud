import { generateWebhookSecret, sealSecret, WEBHOOK_SECRET_GRACE_MS } from '@qelay-cloud/core';
import { WebhookKeyError } from '../errors';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { WEBHOOK_COLUMNS, webhookOf } from './webhookRows';
import type { WebhookRow } from './webhookRows';
import { checkSecret, secretContext } from './webhooks';
import type { WebhookIssued } from './webhookTypes';

/**
 * Replaces a webhook's signing secret with `secret`, or one the store makes. The one it replaces keeps
 * signing beside the new one for `WEBHOOK_SECRET_GRACE_MS` (a delivery carries both signatures), so
 * a receiver can switch over without dropping a delivery; the tick clears it afterwards. Rotating
 * again in that time replaces the older of the two. An unsigned webhook has nothing to keep.
 * `WebhookKeyError` without a `webhookKey`; null when there is no such webhook.
 */
export async function rotateWebhookSecret(
  ctx: StoreContext,
  id: string,
  secret?: string | null
): Promise<WebhookIssued | null> {
  const key = identifier('id', id);
  const given = checkSecret(secret);
  if (ctx.webhookKey === null) {
    throw new WebhookKeyError('webhook secrets need a webhook key; this store was given none');
  }
  const made = given === null ? generateWebhookSecret() : null;
  const sealed = await sealSecret(
    given ?? made!,
    ctx.webhookKey,
    secretContext(ctx.namespace, key)
  );
  return ctx.db.run('rotateWebhookSecret', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const [row] = await tx.unsafe<WebhookRow[]>(
        `UPDATE qcloud_webhooks
         SET secret_previous_sealed = secret_sealed,
             secret_previous_until = CASE WHEN secret_sealed IS NULL THEN NULL ELSE $4::bigint END,
             secret_sealed = $3
         WHERE namespace = $1 AND id = $2
         RETURNING ${WEBHOOK_COLUMNS}`,
        [ctx.namespace, key, sealed, now + WEBHOOK_SECRET_GRACE_MS]
      );
      return row ? { ...webhookOf(row), secret: made } : null;
    })
  );
}
