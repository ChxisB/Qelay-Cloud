import {
  MAX_WEBHOOK_URL_CHARS,
  routeJobId,
  WEBHOOK_DESTINATIONS,
  WEBHOOK_EVENTS,
  WEBHOOK_PAUSE_MODES,
  webhookPausedBy,
} from '@qelay-cloud/core';
import type {
  AttemptRecord,
  WebhookDedupe,
  WebhookDestination,
  WebhookFilter,
  WebhookShape,
} from '@qelay-cloud/core';
import type { DeliveryRecord, WebhookIssued, WebhookRecord } from '@qelay-cloud/store-postgres';
import {
  MAX_BULK_RETRY,
  MAX_DELIVERY_PAGE,
  MAX_SECRET_CHARS,
  MAX_STATS_BUCKETS,
} from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';

/**
 * Webhooks as the panel's Webhooks page reads and writes them (`WebhookFull` and `AddWebhookBody` of
 * the control panel), plus what the delivery history adds. The signing secret is accepted on create
 * and appears in no response, with one exception: a secret the store generated (none was given) is
 * returned once, in the create or rotate response beside the webhook. `signed` says whether there is one.
 */

/**
 * A name, a description, a delay and a dedupe, as `POST /webhooks` and `PATCH /webhooks/:id` take them. The bounds here only
 * keep a body small: the store (core's `validateName` and the others) names the exact rule that a value breaks.
 */
// Typed as the store takes it, though any object gets this far: the store's `validateDedupe` checks it and names the fault.
const dedupeField = z.record(z.string(), z.unknown()).nullable().optional() as unknown as z.ZodType<
  WebhookDedupe | null | undefined
>;

const ruleFields = {
  name: z.string().max(1_000).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
  delayMs: z.number().nullable().optional(),
  dedupe: dedupeField,
};

/**
 * `POST /webhooks`. The store checks the secret's length and the queue name, naming the option. `url`
 * belongs to an `http` route (the default) and `target` to a `queue` route: the route says which is missing. A
 * `destinationId` takes the address from a saved destination instead, so it is given without `destination`, `url` or `target`.
 */
export const webhookBody = z.strictObject({
  destination: z.enum(WEBHOOK_DESTINATIONS).optional(),
  url: z.string().max(MAX_WEBHOOK_URL_CHARS).optional(),
  target: z.string().max(256).nullable().optional(),
  destinationId: z.string().max(256).nullable().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  queue: z.string().max(256).nullable().optional(),
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
  enabled: z.boolean().optional(),
  // Plain JSON objects here; the store validates the grammar (core's `validateFilter`/`validateShape`)
  // and names the first fault, so the rules live in one place.
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  ...ruleFields,
});

/**
 * `PATCH /webhooks/:id`: the fields to change, by name; null clears one (`events` cannot be empty). An empty body is
 * the store's 400. The source queue, the destination and the secret are not editable here.
 */
export const patchBody = z.strictObject({
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  ...ruleFields,
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

/** `PUT /webhooks/:id/enabled`. `mode` is how an off route is paused (`hold` collects events, `ignore` does not) and is moot when turning on. */
export const enabledBody = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(WEBHOOK_PAUSE_MODES).optional(),
});

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

/** `POST /webhooks/:id/deliveries/retry`: put the webhook's failed deliveries back, newest first. */
export const retryFailedBody = z.strictObject({
  status: z.literal('failed'),
  before: z
    .string()
    .regex(/^[1-9]\d{0,15}$/u)
    .optional(),
  limit: z.number().int().min(1).max(MAX_BULK_RETRY).optional(),
});

const epoch = z.coerce.number().int().nonnegative();

/** `GET /webhooks/deliveries`: the history's query, across every webhook, and a time window. */
export const allDeliveriesQuery = deliveriesQuery.extend({
  webhook: z.string().min(1).max(256).optional(),
  since: epoch.optional(),
  until: epoch.optional(),
});

/** `GET /webhooks/stats`. The store bounds the window (7 days). `groupBy=webhook` answers every webhook at once. */
export const statsQuery = z.object({
  since: epoch,
  until: epoch,
  webhook: z.string().min(1).max(256).optional(),
  buckets: z.coerce.number().int().min(1).max(MAX_STATS_BUCKETS).optional(),
  groupBy: z.literal('webhook').optional(),
});

export interface WebhookWire {
  readonly id: string;
  /** `http` POSTs each delivery to `url`; `queue` adds a job to `target` (docs/event-gateway.md). */
  readonly destination: WebhookDestination;
  /** The address of an `http` route; empty for a `queue` route. */
  readonly url: string;
  /** The queue a `queue` route adds jobs to; null for `http`. */
  readonly target: string | null;
  /** The saved destination the address was copied from; null when it was given directly. */
  readonly destinationId: string | null;
  /** True when `url` is only the origin: the caller may read webhooks but not the path a token could be in. */
  readonly urlRedacted: boolean;
  readonly events: readonly string[];
  readonly queue: string | null;
  /** Only events this passes are sent (`docs/webhooks.md`); null sends every event of the list. */
  readonly filter: WebhookFilter | null;
  /** The body template; null sends the default body. */
  readonly shape: WebhookShape | null;
  /** What the operator calls it, and a note; null for none. */
  readonly name: string | null;
  readonly description: string | null;
  /** A delivery is due this many ms after its event; null for at once. */
  readonly delayMs: number | null;
  /** Drops an event whose chosen fields repeat inside the window; null for none. */
  readonly dedupe: WebhookDedupe | null;
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
  /** Who paused a route that is off and collecting: an operator (`hold`) or the failure streak (auto-pause); null otherwise. */
  readonly pausedBy: 'operator' | 'failures' | null;
  /** While a rotated-out secret still signs beside the new one: when it stops. */
  readonly previousSecretUntil: number | null;
}

/**
 * Receivers often take their token in the URL's path or query (a chat tool's incoming-webhook URL is
 * a credential), and a read-only caller has no need of it. An operator, who registered or may change
 * it, sees the whole URL; anyone else sees where it points and not what it says.
 */
export function shownUrl(raw: string, role: Role): { url: string; urlRedacted: boolean } {
  // A queue route has no address, and a queue's name is no secret: nothing to hide.
  if (role === 'operator' || raw === '') return { url: raw, urlRedacted: false };
  try {
    return { url: `${new URL(raw).origin}/`, urlRedacted: true };
  } catch {
    return { url: 'https://invalid.invalid/', urlRedacted: true };
  }
}

export function toWebhookWire(webhook: WebhookRecord, role: Role): WebhookWire {
  return {
    id: webhook.id,
    destination: webhook.destination,
    ...shownUrl(webhook.url, role),
    target: webhook.target,
    destinationId: webhook.destinationId,
    events: webhook.events,
    queue: webhook.queue,
    filter: webhook.filter,
    shape: webhook.shape,
    name: webhook.name,
    description: webhook.description,
    delayMs: webhook.delayMs,
    dedupe: webhook.dedupe,
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
    pausedBy: webhookPausedBy(webhook),
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
  /** The job a delivered `queue` route made in its target queue; null for `http` and until it is delivered. */
  readonly routedJobId: string | null;
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

/**
 * A delivery names no URL and no secret; its errors are the fixed sentences the sender writes. `via` is
 * its route's destination: the store keeps no answer on a success, so a queue route's job is named
 * from the delivery id (core's `routeJobId`).
 */
export function toDeliveryWire(
  delivery: DeliveryRecord,
  via: WebhookDestination = 'http'
): DeliveryWire {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
    queue: delivery.queue,
    jobId: delivery.jobId,
    routedJobId:
      via === 'queue' && delivery.status === 'delivered' ? routeJobId(delivery.id) : null,
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
