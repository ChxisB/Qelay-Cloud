import { MAX_WEBHOOK_URL_CHARS, WEBHOOK_EVENTS } from '@qelay-cloud/core';
import type { AttemptRecord } from '@qelay-cloud/core';
import type { DeliveryRecord, WebhookRecord } from '@qelay-cloud/store-postgres';
import { MAX_DELIVERY_PAGE, MAX_SECRET_CHARS } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';

/**
 * Webhooks as the panel's Webhooks page reads and writes them (`WebhookFull` and `AddWebhookBody` of
 * the control panel), plus what the delivery history adds. The signing secret is accepted on create
 * and appears in no response, ever: `signed` says whether there is one.
 */

/** `POST /webhooks`. The store checks the secret's length and the queue name, naming the option. */
export const webhookBody = z.strictObject({
  url: z.string().max(MAX_WEBHOOK_URL_CHARS),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  queue: z.string().max(256).nullable().optional(),
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const enabledBody = z.strictObject({ enabled: z.boolean() });

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
  readonly signed: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly lastTriggered: number | null;
  readonly successCount: number;
  readonly failureCount: number;
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
    signed: webhook.signed,
    enabled: webhook.enabled,
    createdAt: webhook.createdAt,
    lastTriggered: webhook.lastTriggered,
    successCount: webhook.successCount,
    failureCount: webhook.failureCount,
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
