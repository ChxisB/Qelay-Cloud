import {
  isWebhookEvent,
  MAX_WEBHOOK_URL_CHARS,
  MAX_WEBHOOKS,
  sealSecret,
  UnsupportedOptionError,
  WEBHOOK_EVENTS,
  WEBHOOK_TEST_EVENT,
} from '@qelay-cloud/core';
import { WebhookDisabledError, WebhookKeyError, WebhookLimitError } from '../errors';
import type { StoreContext } from './context';
import { advisoryLockName } from './locks';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type { DeliveryRow, WebhookRow } from './webhookRows';
import {
  DELIVERY_COLUMNS,
  deliveryNumber,
  deliveryOf,
  WEBHOOK_COLUMNS,
  webhookOf,
} from './webhookRows';
import type {
  DeliveryPage,
  DeliveryQuery,
  DeliveryRecord,
  RetryResult,
  WebhookRecord,
  WebhookSpec,
} from './webhookTypes';

/**
 * The operator's side of webhooks (migration 8): registering them and reading what became of their
 * deliveries. The sending side is `webhookClaim.ts`; deliveries are created by the trigger on the
 * event journal (`schema/ddl/webhooks.ts`), or by `sendWebhookTest`.
 */

export const DEFAULT_DELIVERY_PAGE = 50;
export const MAX_DELIVERY_PAGE = 200;
export const MIN_SECRET_CHARS = 16;
export const MAX_SECRET_CHARS = 256;
const MAX_CREATED_BY_CHARS = 200;

/** The queue and job a test delivery names. */
export const TEST_TARGET = 'webhook-test';

/** Binds a sealed secret to its row: the same text sealed for another webhook does not open. */
export const secretContext = (namespace: string, id: string): string => `${namespace}/${id}`;

interface Valid {
  readonly url: string;
  readonly events: string[];
  readonly queue: string | null;
  readonly secret: string | null;
  readonly enabled: boolean;
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
  const secret = spec.secret ?? null;
  if (
    secret !== null &&
    (typeof secret !== 'string' ||
      secret.length < MIN_SECRET_CHARS ||
      secret.length > MAX_SECRET_CHARS)
  ) {
    throw new UnsupportedOptionError(
      'secret',
      `must be ${MIN_SECRET_CHARS} to ${MAX_SECRET_CHARS} characters`
    );
  }
  return {
    url: spec.url,
    events: [...new Set<string>(spec.events)],
    queue: spec.queue == null ? null : identifier('queue', spec.queue),
    secret,
    enabled: spec.enabled ?? true,
  };
}

/**
 * Registers a webhook. Refused, with nothing written, when the namespace already has the most it may
 * (`WebhookLimitError`) or a secret is given and there is no key to seal it with
 * (`WebhookKeyError`). The caller has already judged the address (`validateWebhookUrl`): the store
 * keeps what it is given.
 */
export async function createWebhook(
  ctx: StoreContext,
  spec: WebhookSpec,
  createdBy: string
): Promise<WebhookRecord> {
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
      const id = ctx.nextId(now);
      const sealed =
        valid.secret === null
          ? null
          : await sealSecret(valid.secret, ctx.webhookKey!, secretContext(ctx.namespace, id));
      const [row] = await tx<WebhookRow[]>`
        INSERT INTO qcloud_webhooks
          (namespace, id, url, events, queue, secret_sealed, enabled, created_by, created_at)
        VALUES (${ctx.namespace}, ${id}, ${valid.url}, ${tx.array(valid.events, 'TEXT')}, ${valid.queue},
                ${sealed}, ${valid.enabled}, ${owner}, ${now})
        RETURNING id, url, events, queue, secret_sealed, enabled, created_by, created_at,
                  success_count, failure_count, last_triggered`;
      return webhookOf(row!);
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
 * have outlived `WEBHOOK_DELIVERY_EXPIRY_MS`. Null when there is no such webhook.
 */
export async function setWebhookEnabled(
  ctx: StoreContext,
  id: string,
  enabled: boolean
): Promise<WebhookRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('setWebhookEnabled', async (sql) => {
    const [row] = await sql.unsafe<WebhookRow[]>(
      `UPDATE qcloud_webhooks SET enabled = $3 WHERE namespace = $1 AND id = $2
       RETURNING ${WEBHOOK_COLUMNS}`,
      [ctx.namespace, key, enabled]
    );
    return row ? webhookOf(row) : null;
  });
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
        `INSERT INTO qcloud_webhook_deliveries
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
      `SELECT ${DELIVERY_COLUMNS} FROM qcloud_webhook_deliveries
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

const STATUSES: readonly string[] = ['pending', 'sending', 'delivered', 'failed'];

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
        `UPDATE qcloud_webhook_deliveries
         SET status = 'pending', next_attempt_at = $4, attempt_base = attempts, finished_at = NULL
         WHERE namespace = $1 AND webhook_id = $2 AND id = $3 AND status = 'failed'
         RETURNING ${DELIVERY_COLUMNS}`,
        [ctx.namespace, key, delivery, now]
      );
      if (row) return { outcome: 'retried', delivery: deliveryOf(row) } as const;
      const [current] = await tx<Array<{ status: string }>>`
        SELECT status FROM qcloud_webhook_deliveries
        WHERE namespace = ${ctx.namespace} AND webhook_id = ${key} AND id = ${delivery}`;
      return current
        ? ({ outcome: 'not_failed', status: current.status as DeliveryRecord['status'] } as const)
        : ({ outcome: 'not_found' } as const);
    })
  );
}
