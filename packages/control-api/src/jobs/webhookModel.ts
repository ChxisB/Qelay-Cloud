import {
  MAX_WEBHOOK_URL_CHARS,
  WEBHOOK_DESTINATIONS,
  WEBHOOK_PAUSE_MODES,
  webhookPausedBy,
} from '@qelay-cloud/core';
import type {
  WebhookBatch,
  WebhookDedupe,
  WebhookDestination,
  WebhookFilter,
  WebhookSchedule,
  WebhookShape,
} from '@qelay-cloud/core';
import type { WebhookIssued, WebhookRecord } from '@qelay-cloud/store-postgres';
import {
  MAX_BULK_RETRY,
  MAX_DELIVERY_PAGE,
  MAX_SECRET_CHARS,
  MAX_STATS_BUCKETS,
  nextFire,
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
 * A name, a description, a delay, a dedupe, a schedule and a batch, as `POST /webhooks` and `PATCH /webhooks/:id` take them. The bounds here only
 * keep a body small: the store (core's `validateName` and the others) names the exact rule that a value breaks.
 */
// Typed as the store takes it, though any object gets this far: the store's `validateDedupe` checks it and names the fault.
const dedupeField = z.record(z.string(), z.unknown()).nullable().optional() as unknown as z.ZodType<
  WebhookDedupe | null | undefined
>;
// The same for the send schedule and batch (D15): `validateSchedule` and `validateBatch` name the fault.
const scheduleField = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional() as unknown as z.ZodType<WebhookSchedule | null | undefined>;
const batchField = z.record(z.string(), z.unknown()).nullable().optional() as unknown as z.ZodType<
  WebhookBatch | null | undefined
>;

const ruleFields = {
  name: z.string().max(1_000).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
  delayMs: z.number().nullable().optional(),
  dedupe: dedupeField,
  schedule: scheduleField,
  batch: batchField,
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
  // The inbound source whose requests the route delivers (D14). The store names the option when it is missing.
  source: z.string().max(256).nullable().optional(),
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
  enabled: z.boolean().optional(),
  // Plain JSON objects here; the store validates the grammar (core's `validateFilter`/`validateShape`)
  // and names the first fault, so the rules live in one place.
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  ...ruleFields,
});

/**
 * `PATCH /webhooks/:id`: the fields to change, by name; null clears one. An empty body is
 * the store's 400. The destination and the secret are not editable here.
 */
export const patchBody = z.strictObject({
  /** Moves the route to another source. */
  source: z.string().max(256).optional(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  ...ruleFields,
});

/** `POST /webhooks/preview`: a filter and a shape tried on one made-up request, nothing saved or sent. */
export const previewBody = z.strictObject({
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  shape: z.record(z.string(), z.unknown()).nullable().optional(),
  /** What a rule reads (D14): `body` is the parsed JSON, left out for a request that was not JSON. */
  request: z.strictObject({
    method: z.string().min(1).max(16).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
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
  /** The inbound source whose requests the route delivers (D14); null for a route from before sources, which is disabled. */
  readonly source: string | null;
  /** Only requests this passes are sent (`docs/webhooks.md`); null sends every request. */
  readonly filter: WebhookFilter | null;
  /** The body template; null sends the request's own body. */
  readonly shape: WebhookShape | null;
  /** What the operator calls it, and a note; null for none. */
  readonly name: string | null;
  readonly description: string | null;
  /** A delivery is due this many ms after its request; null for at once. */
  readonly delayMs: number | null;
  /** Drops a request whose chosen fields repeat inside the window; null for none. */
  readonly dedupe: WebhookDedupe | null;
  /** Holds deliveries until the cron next fires, in the zone (D15); null sends at once. */
  readonly schedule: WebhookSchedule | null;
  /** When the schedule next fires (epoch ms); null without a schedule, or one the cron parser can no longer read. */
  readonly nextSendAt: number | null;
  /** Sends due deliveries as one request (D15); `http` routes only; null sends one request each. */
  readonly batch: WebhookBatch | null;
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

export function toWebhookWire(webhook: WebhookRecord, role: Role, now: number): WebhookWire {
  return {
    id: webhook.id,
    destination: webhook.destination,
    ...shownUrl(webhook.url, role),
    target: webhook.target,
    destinationId: webhook.destinationId,
    source: webhook.source,
    filter: webhook.filter,
    shape: webhook.shape,
    name: webhook.name,
    description: webhook.description,
    delayMs: webhook.delayMs,
    dedupe: webhook.dedupe,
    schedule: webhook.schedule,
    nextSendAt: nextSend(webhook.schedule, now),
    batch: webhook.batch,
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

function nextSend(schedule: WebhookSchedule | null, now: number): number | null {
  if (schedule === null) return null;
  try {
    return nextFire(schedule, now) || null;
  } catch {
    return null;
  }
}

/** `data` of a create or rotate response: the webhook, and the secret when the store made it. */
export function toIssuedWire(
  webhook: WebhookIssued,
  now: number
): { webhook: WebhookWire; secret?: string } {
  return {
    webhook: toWebhookWire(webhook, 'operator', now),
    ...(webhook.secret === null ? {} : { secret: webhook.secret }),
  };
}
