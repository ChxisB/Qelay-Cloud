import {
  generateWebhookSecret,
  MAX_WEBHOOKS,
  sealSecret,
  UnsupportedOptionError,
  WEBHOOK_HOLD_REASON,
  WEBHOOK_TEST_EVENT,
} from '@qelay-cloud/core';
import type { WebhookPauseMode } from '@qelay-cloud/core';
import { WebhookDisabledError, WebhookKeyError, WebhookLimitError } from '../errors';
import type { StoreContext } from './context';
import { advisoryLockName } from './locks';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { specFromDestination } from './webhookDestinations';
import type { DeliveryRow, WebhookRow } from './webhookRows';
import { DELIVERY_COLUMNS, deliveryOf, WEBHOOK_COLUMNS, webhookOf } from './webhookRows';
import type { DeliveryRecord, WebhookIssued, WebhookRecord, WebhookSpec } from './webhookTypes';
import { checkSecret, validate } from './webhookValidate';

/**
 * The operator's side of webhooks (migration 8): registering them and reading what became of their
 * deliveries. The sending side is `webhookClaim.ts`; deliveries are created when a source takes a request
 * (`inboundFanOut.ts`), or by `sendWebhookTest`.
 */

export { checkSecret, MAX_SECRET_CHARS, MIN_SECRET_CHARS } from './webhookValidate';
const MAX_CREATED_BY_CHARS = 200;

const json = (value: object | null): string | null =>
  value === null ? null : JSON.stringify(value);

/** Binds a sealed secret to its row: the same text sealed for another webhook does not open. */
export const secretContext = (namespace: string, id: string): string => `${namespace}/${id}`;

/**
 * Registers a webhook. Refused, with nothing written, when the namespace already has the most it may
 * (`WebhookLimitError`), the spec names no source or one that does not exist (`UnsupportedOptionError`), or a secret
 * is given and there is no key to seal it with (`WebhookKeyError`). Without a secret, the store makes one when it has a key (`WebhookIssued.secret`,
 * shown once): a webhook is signed unless the store cannot seal a secret. The caller has already
 * judged the address (`validateWebhookUrl`): the store keeps what it is given.
 */
export async function createWebhook(
  ctx: StoreContext,
  spec: WebhookSpec,
  createdBy: string
): Promise<WebhookIssued> {
  // From a saved destination the address is read in the transaction, so the rest is checked there.
  const destinationId =
    spec.destinationId == null ? null : identifier('destinationId', spec.destinationId);
  const given = destinationId === null ? validate(spec) : null;
  const owner = identifier('createdBy', createdBy).slice(0, MAX_CREATED_BY_CHARS);
  if (checkSecret(spec.secret) !== null && ctx.webhookKey === null) {
    throw new WebhookKeyError('webhook secrets need a webhook key; this store was given none');
  }
  return ctx.db.run('createWebhook', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // Counting is only safe if creations of this namespace take turns.
      const lock = advisoryLockName('webhooks', ctx.namespace);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      const [counted] = await tx<Array<{ n: number | string }>>`
        SELECT count(*) AS n FROM qcloud_webhooks WHERE namespace = ${ctx.namespace}`;
      if (Number(counted!.n) >= MAX_WEBHOOKS) throw new WebhookLimitError(MAX_WEBHOOKS);
      const valid = given ?? validate(await specFromDestination(tx, ctx, spec, destinationId!));
      // KEY SHARE: a delete of the source in flight finishes first, and we see it gone.
      const [found] = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${valid.source} FOR KEY SHARE`;
      if (!found) throw new UnsupportedOptionError('source', 'no such source');
      const id = ctx.nextId(now);
      const made =
        valid.secret === null && ctx.webhookKey !== null && valid.destination === 'http'
          ? generateWebhookSecret()
          : null;
      const secret = valid.secret ?? made;
      const sealed =
        secret === null
          ? null
          : await sealSecret(secret, ctx.webhookKey!, secretContext(ctx.namespace, id));
      const [row] = await tx<WebhookRow[]>`
        INSERT INTO qcloud_webhooks
          (namespace, id, destination, url, target, destination_id, source_id, secret_sealed, enabled,
           filter, shape, name, description, delay_ms, dedupe, schedule_cron, schedule_timezone,
           batch_max_events, batch_max_bytes, created_by, created_at)
        VALUES (${ctx.namespace}, ${id}, ${valid.destination}, ${valid.url}, ${valid.target}, ${destinationId},
                ${valid.source},
                ${sealed}, ${valid.enabled}, ${json(valid.filter)}::text::jsonb,
                ${json(valid.shape)}::text::jsonb, ${valid.name}, ${valid.description},
                ${valid.delayMs}, ${json(valid.dedupe)}::text::jsonb,
                ${valid.schedule?.cron ?? null}, ${valid.schedule?.timezone ?? null},
                ${valid.batch?.maxEvents ?? null}, ${valid.batch?.maxBytes ?? null}, ${owner}, ${now})
        RETURNING id, destination, url, target, destination_id, source_id, secret_sealed, enabled, filter,
                  shape, name, description, delay_ms, dedupe, schedule_cron, schedule_timezone,
                  batch_max_events, batch_max_bytes, created_by, created_at, success_count,
                  failure_count, last_triggered, consecutive_failures, alert_level, disabled_reason,
                  disabled_at, secret_previous_until`;
      return { ...webhookOf(row!), secret: made };
    })
  );
}

/** Every webhook of the namespace, oldest first. */
export async function listWebhooks(ctx: StoreContext): Promise<WebhookRecord[]> {
  return ctx.db.run('listWebhooks', async (sql) => {
    const rows = await sql.unsafe<WebhookRow[]>(
      `SELECT ${WEBHOOK_COLUMNS} FROM qcloud_webhooks WHERE namespace = $1 ORDER BY created_at, id`,
      [ctx.namespace]
    );
    return rows.map(webhookOf);
  });
}

export async function getWebhook(ctx: StoreContext, id: string): Promise<WebhookRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('getWebhook', async (sql) => {
    const [row] = await sql.unsafe<WebhookRow[]>(
      `SELECT ${WEBHOOK_COLUMNS} FROM qcloud_webhooks WHERE namespace = $1 AND id = $2`,
      [ctx.namespace, key]
    );
    return row ? webhookOf(row) : null;
  });
}

/**
 * Turns a webhook on or off. Off stops sending at once, retries included. With `mode: 'ignore'` (the default) it
 * also stops new deliveries being created; with `'hold'` they are still made and wait (the reason is
 * `WEBHOOK_HOLD_REASON`, or stays what it was for a webhook paused for failing, and the failure streak is not
 * touched). Deliveries already waiting stay and go out when it is turned on again, unless they have outlived
 * `WEBHOOK_DELIVERY_EXPIRY_MS`. A webhook paused for failing is off but still has deliveries made; on ends the
 * pause and sends what was held, off with `ignore` ends the pause and the holding. `mode` is moot when turning on.
 * Null when there is no such webhook. A route with no source (one from before sources) cannot be turned on:
 * `UnsupportedOptionError('source', …)`, nothing changed.
 */
export async function setWebhookEnabled(
  ctx: StoreContext,
  id: string,
  enabled: boolean,
  mode: WebhookPauseMode = 'ignore'
): Promise<WebhookRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('setWebhookEnabled', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // Either way ends a pause and, on, the streak.
      const [row] = await tx.unsafe<WebhookRow[]>(
        `UPDATE qcloud_webhooks
         SET enabled = $3,
             disabled_reason = CASE WHEN $3 OR NOT $5 THEN NULL ELSE coalesce(disabled_reason, $6) END,
             disabled_at = CASE WHEN $3 OR NOT $5 THEN NULL ELSE coalesce(disabled_at, $4) END,
             consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END,
             alert_level = CASE WHEN $3 THEN 0 ELSE alert_level END
         WHERE namespace = $1 AND id = $2
         RETURNING ${WEBHOOK_COLUMNS}`,
        [ctx.namespace, key, enabled, now, mode === 'hold', WEBHOOK_HOLD_REASON]
      );
      if (row && enabled && row.source_id === null) {
        throw new UnsupportedOptionError(
          'source',
          'a route needs a source before it can be turned on'
        );
      }
      return row ? webhookOf(row) : null;
    })
  );
}

/** Deletes a webhook and its deliveries. False when there was none. */
export async function deleteWebhook(ctx: StoreContext, id: string): Promise<boolean> {
  const key = identifier('id', id);
  return ctx.db.run('deleteWebhook', async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM qcloud_webhooks WHERE namespace = ${ctx.namespace} AND id = ${key} RETURNING id`;
    return rows.length > 0;
  });
}

/**
 * Queues one `webhook.test` delivery for this webhook, whatever its source sends. It is an
 * ordinary delivery from then on (signed, retried, recorded). Null when there is no such webhook;
 * `WebhookDisabledError` when it is off, because nothing would send it.
 */
export async function sendWebhookTest(
  ctx: StoreContext,
  id: string
): Promise<DeliveryRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('sendWebhookTest', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // KEY SHARE: a delete of this webhook in flight finishes first, and we see it gone.
      const [hook] = await tx<Array<{ enabled: boolean }>>`
        SELECT enabled FROM qcloud_webhooks
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR KEY SHARE`;
      if (!hook) return null;
      if (!hook.enabled) throw new WebhookDisabledError('the webhook is disabled; enable it first');
      const [row] = await tx.unsafe<DeliveryRow[]>(
        `INSERT INTO qcloud_deliveries
           (namespace, webhook_id, event_id, event_name, occurred_at, status, next_attempt_at, created_at)
         VALUES ($1, $2, NULL, $3, $4, 'pending', $4, $4)
         RETURNING ${DELIVERY_COLUMNS}`,
        [ctx.namespace, key, WEBHOOK_TEST_EVENT, now]
      );
      return deliveryOf(row!);
    })
  );
}
