import { UnsupportedOptionError } from './errors';
import type { WEBHOOK_REQUEST_EVENT } from './inboundSource';

/**
 * Webhooks: an operator points a route at a destination, and the service delivers each request its source took
 * to it, at least once (DESIGN.md D14). This file is the part that needs no I/O: the names, the retry schedule and
 * the test body. Signing is `webhookCrypto.ts`, the address rules `webhookUrl.ts`, the tables `store.webhooks`,
 * the sending `@qelay-cloud/maintenance`.
 */

/** What "send test event" delivers. A test goes to one webhook whatever its source. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export type DeliveredEvent = typeof WEBHOOK_TEST_EVENT | typeof WEBHOOK_REQUEST_EVENT;

/** How a delivery is retried. */
export interface DeliveryPolicy {
  /** Attempts per delivery, the first included. At least 1. */
  readonly maxAttempts: number;
  /** The wait after the first failed attempt; each further failure doubles it. */
  readonly baseDelayMs: number;
  /** The longest wait between two attempts. */
  readonly maxDelayMs: number;
  /**
   * Deliveries of one webhook that fail in a row (every attempt used) after which it is paused: no more
   * sending, held deliveries kept until they expire. 0 never pauses. Default 20.
   */
  readonly disableAfter?: number;
}

/** Eight attempts over 63.5 minutes: 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m between them. */
export const DEFAULT_DELIVERY_POLICY: Required<DeliveryPolicy> = {
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
  disableAfter: 20,
};

export function resolveDeliveryPolicy(
  partial: Partial<DeliveryPolicy> = {}
): Required<DeliveryPolicy> {
  const policy = { ...DEFAULT_DELIVERY_POLICY, ...partial };
  for (const key of ['maxAttempts', 'baseDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) {
      throw new UnsupportedOptionError(key, 'must be a positive integer');
    }
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new UnsupportedOptionError('maxDelayMs', 'must not be less than baseDelayMs');
  }
  if (!Number.isSafeInteger(policy.disableAfter) || policy.disableAfter < 0) {
    throw new UnsupportedOptionError('disableAfter', 'must be a non-negative integer');
  }
  return policy;
}

/** Alerts at these shares of `disableAfter` (percent); the last is the pause. Level 0 is none. */
export const WEBHOOK_ALERT_PERCENTS = [50, 70, 90, 100] as const;

/** 0 to 4: how far `streak` failed deliveries in a row have come toward `disableAfter` (0: never, so level 0). */
export function webhookAlertLevel(streak: number, disableAfter: number): number {
  if (disableAfter <= 0) return 0;
  const percent = (streak * 100) / disableAfter;
  return WEBHOOK_ALERT_PERCENTS.filter((at) => percent >= at).length;
}

/** How long a rotated-out secret still signs, beside the new one, so a receiver can switch over. */
export const WEBHOOK_SECRET_GRACE_MS = 24 * 3_600_000;

/**
 * The wait before the next attempt, after `failedAttempts` attempts of this delivery have failed:
 * `baseDelayMs` doubled for each failure after the first, never more than `maxDelayMs`.
 *
 * Given `random` (a number in [0, 1)), the wait is spread by plus or minus 20%, so the deliveries a
 * receiver refused in one outage do not all come back in the same second. A wait already at
 * `maxDelayMs` is only spread downward, so the cap still holds. Without `random` the schedule is exact.
 */
export function webhookRetryDelayMs(
  failedAttempts: number,
  policy: DeliveryPolicy,
  random?: () => number
): number {
  const doublings = Math.max(0, Math.min(failedAttempts - 1, 60));
  const delay = Math.min(policy.baseDelayMs * 2 ** doublings, policy.maxDelayMs);
  if (random === undefined) return delay;
  const high = delay >= policy.maxDelayMs ? 1 : 1.2;
  return Math.round(delay * (0.8 + (high - 0.8) * random()));
}

/** What a test delivery carries: where and when only. A request's delivery sends the request, not this. */
export interface DeliveryBodyInput {
  /** The delivery's id: the same on every attempt, so a receiver deduplicates on it. */
  readonly id: string;
  readonly event: DeliveredEvent;
  /** When the event happened, epoch milliseconds. */
  readonly occurredAt: number;
}

/** The JSON text that is POSTed and signed for a test event. */
export function deliveryBody(input: DeliveryBodyInput): string {
  return JSON.stringify({ id: input.id, event: input.event, timestamp: input.occurredAt });
}

/** One attempt, as the delivery history records it. */
export interface AttemptRecord {
  readonly attempt: number;
  /** When the attempt started, epoch milliseconds. */
  readonly at: number;
  readonly durationMs: number;
  /** The receiver's status, or null when none came back (refused, timed out, blocked). */
  readonly statusCode: number | null;
  /** Why the attempt did not succeed, or null when it did. Short; fixed sentences. */
  readonly error: string | null;
  /**
   * The first bytes of a failed attempt's answer, as text, when the sender captured them
   * (`WEBHOOK_RESPONSE_CHARS` at most). Absent for a success and when capture is off.
   */
  readonly response?: string | null;
  /** The batch request this attempt went out in (D15); absent for a delivery sent alone. */
  readonly batchId?: string;
}

export type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';

/** Longest `last_error` a delivery keeps, in characters. */
export const WEBHOOK_ERROR_CHARS = 500;

/** Most of a failed answer's body one attempt's history entry keeps, in characters. */
export const WEBHOOK_RESPONSE_CHARS = 1_024;

/** Attempts a delivery's history keeps; the oldest are dropped past it. */
export const WEBHOOK_HISTORY_ENTRIES = 20;

/** The header names of a delivery, so the sender and the receiver documentation cannot drift apart. */
export const WEBHOOK_HEADERS = {
  id: 'X-Webhook-Id',
  event: 'X-Webhook-Event',
  timestamp: 'X-Webhook-Timestamp',
  attempt: 'X-Webhook-Attempt',
  signature: 'X-Webhook-Signature',
  /** The body's layout version, so a receiver can tell when it changes. Shaped bodies are the operator's own. */
  schema: 'X-Webhook-Schema',
} as const;

/** The layout of the test body (`deliveryBody`). */
export const WEBHOOK_SCHEMA_VERSION = '1';

/** Webhooks one namespace can register. */
export const MAX_WEBHOOKS = 100;

/** Longest webhook URL, in characters. */
export const MAX_WEBHOOK_URL_CHARS = 2_048;
