import { MAX_WEBHOOK_URL_CHARS, WEBHOOK_EVENTS } from '@qelay-cloud/core';
import type { AttemptRecord, WebhookFilter, WebhookShape } from '@qelay-cloud/core';
import type { DeliveryRecord, WebhookIssued, WebhookRecord } from '@qelay-cloud/store-postgres';
import { MAX_DELIVERY_PAGE, MAX_SECRET_CHARS } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';

/**
 * Webhooks as the panel's Webhooks page reads and writes them (`WebhookFull` and `AddWebhookBody` of
 * the control panel), plus what the delivery history adds. The signing secret is accepted on create
 * and appears in no response, with one exception: a secret the store generated (none was given) is
 * returned once, in the create or rotate response beside the webhook. `signed` says whether there is one.
 */

/** `POST /webhooks`. The store checks the secret's length and the queue name, naming the option. */
export const webhookBody = z.strictObject({
  url: z.string().max(MAX_WEBHOOK_URL_CHARS),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  queue: z.string().max(256).nullable().optional(),
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
  enabled: z.boolean().optional(),
  // Plain JSON objects here; the store validates the grammar (core's `validateFilter`/`validateShape`)
  // and names the first fault, so the rules live in one place.
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** `POST /webhooks/preview`: a filter and a shape tried on one made-up event, nothing saved or sent. */
export const previewBody = z.strictObject({
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  event: z.strictObject({
    event: z.enum(WEBHOOK_EVENTS),
    queue: z.string().min(1).max(256),
    jobId: z.string().min(1).max(256),
    occurredAt: z.number().int().nonnegative().optional(),
    state: z.string().max(64).nullable().optional(),
    error: z.string().max(4096).nullable().optional(),
    progress: z.number().finite().nullable().optional(),
  }),
});

export const enabledBody = z.strictObject({ enabled: z.boolean() });

/** `POST /webhooks/:id/rotate-secret`: the new secret, or none to have one generated. The body may be left out. */
export const rotateBody = z.strictObject({
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
});

export const deliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DELIVERY_PAGE).optional(),
  before: z
    .string()
    .regex(/^[1-9]\d{0,15}$/u)
    .optional(),
  status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(),
});

export interface WebhookWire {
  readonly id: string;
  readonly url: string;
  /** True when `url` is only the origin: the caller may read webhooks but not the path a token could be in. */
  readonly urlRedacted: boolean;
  readonly events: readonly string[];
  readonly queue: string | null;
  /** Only events this passes are sent (`docs/webhooks.md`); null sends every event of the list. */
  readonly filter: WebhookFilter | null;
  /** The body template; null sends the default body. */
  readonly shape: WebhookShape | null;
  readonly signed: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly lastTriggered: number | null;
  readonly successCount: number;
  readonly failureCount: number;
  /** Failed deliveries in a row (every attempt used); a delivered one resets it. */
  readonly consecutiveFailures: number;
  /** 0 to 4: the streak's progress toward the pause (50, 70, 90 and 100% of `disableAfter`). */
  readonly alertLevel: number;
  /** Set when the webhook was paused after repeated failures; `enabled` is then false. Null otherwise. */
  readonly disabledReason: string | null;
  readonly disabledAt: number | null;
  /** While a rotated-out secret still signs beside the new one: when it stops. */
  readonly previousSecretUntil: number | null;
}

/**
 * Receivers often take their token in the URL's path or query (a chat tool's incoming-webhook URL is
 * a credential), and a read-only caller has no need of it. An operator, who registered or may change
 * it, sees the whole URL; anyone else sees where it points and not what it says.
 */
function shownUrl(raw: string, role: Role): { url: string; urlRedacted: boolean } {
  if (role === 'operator') return { url: raw, urlRedacted: false };
  try {
    return { url: `${new URL(raw).origin}/`, urlRedacted: true };
  } catch {
    return { url: 'https://invalid.invalid/', urlRedacted: true };
  }
}

export function toWebhookWire(webhook: WebhookRecord, role: Role): WebhookWire {
  return {
    id: webhook.id,
    ...shownUrl(webhook.url, role),
    events: webhook.events,
    queue: webhook.queue,
    filter: webhook.filter,
    shape: webhook.shape,
    signed: webhook.signed,
    enabled: webhook.enabled,
    createdAt: webhook.createdAt,
    lastTriggered: webhook.lastTriggered,
    successCount: webhook.successCount,
    failureCount: webhook.failureCount,
    consecutiveFailures: webhook.consecutiveFailures,
    alertLevel: webhook.alertLevel,
    disabledReason: webhook.disabledReason,
    disabledAt: webhook.disabledAt,
    previousSecretUntil: webhook.previousSecretUntil,
  };
}

/** `data` of a create or rotate response: the webhook, and the secret when the store made it. */
export function toIssuedWire(webhook: WebhookIssued): { webhook: WebhookWire; secret?: string } {
  return {
    webhook: toWebhookWire(webhook, 'operator'),
    ...(webhook.secret === null ? {} : { secret: webhook.secret }),
  };
}

export interface DeliveryWire {
  readonly id: string;
  readonly webhookId: string;
  readonly event: string;
  readonly queue: string;
  readonly jobId: string;
  readonly occurredAt: number;
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly history: readonly AttemptRecord[];
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

/** A delivery names no URL and no secret; its errors are the fixed sentences the sender writes. */
export function toDeliveryWire(delivery: DeliveryRecord): DeliveryWire {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
    queue: delivery.queue,
    jobId: delivery.jobId,
    occurredAt: delivery.occurredAt,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    history: delivery.history,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
  };
}
