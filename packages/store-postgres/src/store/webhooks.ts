import {
  generateWebhookSecret,
  isWebhookEvent,
  MAX_WEBHOOK_URL_CHARS,
  MAX_WEBHOOKS,
  sealSecret,
  UnsupportedOptionError,
  validateFilter,
  validateShape,
  WEBHOOK_EVENTS,
  WEBHOOK_TEST_EVENT,
} from '@qelay-cloud/core';
import type { WebhookFilter, WebhookShape } from '@qelay-cloud/core';
import { WebhookDisabledError, WebhookKeyError, WebhookLimitError } from '../errors';
import type { StoreContext } from './context';
import { advisoryLockName } from './locks';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type { DeliveryRow, WebhookRow } from './webhookRows';
import { DELIVERY_COLUMNS, deliveryOf, WEBHOOK_COLUMNS, webhookOf } from './webhookRows';
import type { DeliveryRecord, WebhookIssued, WebhookRecord, WebhookSpec } from './webhookTypes';

/**
 * The operator's side of webhooks (migration 8): registering them and reading what became of their
 * deliveries. The sending side is `webhookClaim.ts`; deliveries are created by the trigger on the
 * event journal (`schema/ddl/webhooks.ts`), or by `sendWebhookTest`.
 */

export const MIN_SECRET_CHARS = 16;
export const MAX_SECRET_CHARS = 256;
const MAX_CREATED_BY_CHARS = 200;

/** The queue and job a test delivery names. */
export const TEST_TARGET = 'webhook-test';

const json = (value: object | null): string | null =>
  value === null ? null : JSON.stringify(value);

/** Binds a sealed secret to its row: the same text sealed for another webhook does not open. */
export const secretContext = (namespace: string, id: string): string => `${namespace}/${id}`;

interface Valid {
  readonly url: string;
  readonly events: string[];
  readonly queue: string | null;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
}

/** The secret as given (null for none), or `UnsupportedOptionError('secret', …)`. */
export function checkSecret(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < MIN_SECRET_CHARS ||
    value.length > MAX_SECRET_CHARS
  ) {
    throw new UnsupportedOptionError(
      'secret',
      `must be ${MIN_SECRET_CHARS} to ${MAX_SECRET_CHARS} characters`
    );
  }
  return value;
}

function validate(spec: WebhookSpec): Valid {
  if (typeof spec.url !== 'string' || spec.url === '' || spec.url.length > MAX_WEBHOOK_URL_CHARS) {
    throw new UnsupportedOptionError(
      'url',
      `must be a string of 1 to ${MAX_WEBHOOK_URL_CHARS} characters`
    );
  }
  if (spec.url.includes('\0')) throw new UnsupportedOptionError('url', 'must not contain NUL');
  if (!Array.isArray(spec.events) || spec.events.length === 0) {
    throw new UnsupportedOptionError(
      'events',
      `must name at least one of ${WEBHOOK_EVENTS.join(', ')}`
    );
  }
  for (const event of spec.events) {
    if (!isWebhookEvent(event)) {
      throw new UnsupportedOptionError('events', `unknown event; use ${WEBHOOK_EVENTS.join(', ')}`);
    }
  }
  const secret = checkSecret(spec.secret);
  return {
    url: spec.url,
    events: [...new Set<string>(spec.events)],
    queue: spec.queue == null ? null : identifier('queue', spec.queue),
    secret,
    enabled: spec.enabled ?? true,
    filter: spec.filter == null ? null : validateFilter(spec.filter),
    shape: spec.shape == null ? null : validateShape(spec.shape),
  };
}

/**
 * Registers a webhook. Refused, with nothing written, when the namespace already has the most it may
 * (`WebhookLimitError`) or a secret is given and there is no key to seal it with
 * (`WebhookKeyError`). Without a secret, the store makes one when it has a key (`WebhookIssued.secret`,
 * shown once): a webhook is signed unless the store cannot seal a secret. The caller has already
 * judged the address (`validateWebhookUrl`): the store keeps what it is given.
 */
export async function createWebhook(
  ctx: StoreContext,
  spec: WebhookSpec,
  createdBy: string
): Promise<WebhookIssued> {
  const valid = validate(spec);
  const owner = identifier('createdBy', createdBy).slice(0, MAX_CREATED_BY_CHARS);
  if (valid.secret !== null && ctx.webhookKey === null) {
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
      if (valid.filter !== null || valid.shape !== null) {
        // KEY SHARE: switching the writer off waits for this transaction, then sees the webhook.
        const [writer] = await tx<Array<{ namespace: string }>>`
          SELECT namespace FROM qcloud_webhook_writers
          WHERE namespace = ${ctx.namespace} AND NOT stopping FOR KEY SHARE`;
        if (!writer) {
          throw new UnsupportedOptionError(
            valid.filter !== null ? 'filter' : 'shape',
            'needs the webhook delivery writer: switch it on first (qcloud-tick webhook-writer on)'
          );
        }
      }
      const id = ctx.nextId(now);
      const made =
        valid.secret === null && ctx.webhookKey !== null ? generateWebhookSecret() : null;
      const secret = valid.secret ?? made;
      const sealed =
        secret === null
          ? null
          : await sealSecret(secret, ctx.webhookKey!, secretContext(ctx.namespace, id));
      const [row] = await tx<WebhookRow[]>`
        INSERT INTO qcloud_webhooks
          (namespace, id, url, events, queue, secret_sealed, enabled, filter, shape, created_by,
           created_at, active_from)
        VALUES (${ctx.namespace}, ${id}, ${valid.url}, ${tx.array(valid.events, 'TEXT')}, ${valid.queue},
                ${sealed}, ${valid.enabled}, ${json(valid.filter)}::text::jsonb,
                ${json(valid.shape)}::text::jsonb, ${owner}, ${now}, ${now})
        RETURNING id, url, events, queue, secret_sealed, enabled, filter, shape, created_by,
                  created_at, success_count, failure_count, last_triggered, consecutive_failures,
                  alert_level, disabled_reason, disabled_at, secret_previous_until`;
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
 * Turns a webhook on or off. Off stops sending at once, retries included, and stops new deliveries
 * being created; deliveries already waiting stay and go out when it is turned on again, unless they
 * have outlived `WEBHOOK_DELIVERY_EXPIRY_MS`. A webhook paused for failing is off but still has
 * deliveries made; on ends the pause and sends what was held, off ends the pause and the holding.
 * Null when there is no such webhook.
 */
export async function setWebhookEnabled(
  ctx: StoreContext,
  id: string,
  enabled: boolean
): Promise<WebhookRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('setWebhookEnabled', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // `active_from`: the delivery writer does not deliver events from before the webhook was turned on,
      // except a paused one's (its deliveries were made all along). Either way ends a pause and, on, the streak.
      const [row] = await tx.unsafe<WebhookRow[]>(
        `UPDATE qcloud_webhooks
         SET enabled = $3, disabled_reason = NULL, disabled_at = NULL,
             active_from = CASE WHEN $3 AND NOT enabled AND disabled_reason IS NULL THEN $4 ELSE active_from END,
             consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END,
             alert_level = CASE WHEN $3 THEN 0 ELSE alert_level END
         WHERE namespace = $1 AND id = $2
         RETURNING ${WEBHOOK_COLUMNS}`,
        [ctx.namespace, key, enabled, now]
      );
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
 * Queues one `webhook.test` delivery for this webhook, whatever events it listens for. It is an
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
           (namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status,
            next_attempt_at, created_at)
         VALUES ($1, $2, NULL, $3, $4, $4, $5, 'pending', $5, $5)
         RETURNING ${DELIVERY_COLUMNS}`,
        [ctx.namespace, key, WEBHOOK_TEST_EVENT, TEST_TARGET, now]
      );
      return deliveryOf(row!);
    })
  );
}
