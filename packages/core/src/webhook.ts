import { UnsupportedOptionError } from './errors';

/**
 * Webhooks: an operator registers a URL and the events it wants, and the service POSTs each matching
 * job event to it, at least once. This file is the part that needs no I/O: the names, the retry
 * schedule and the body. Signing is `webhookCrypto.ts`, the address rules `webhookUrl.ts`, the
 * tables `store.webhooks`, the sending `@qelay-cloud/maintenance`.
 */

/** The events a webhook can subscribe to, named as the panel names them. */
export const WEBHOOK_EVENTS = [
  'job.pushed',
  'job.started',
  'job.completed',
  'job.failed',
  'job.progress',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** What "send test event" delivers. Not subscribable: a test goes to one webhook whatever it listens for. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export type DeliveredEvent = WebhookEvent | typeof WEBHOOK_TEST_EVENT;

/**
 * Which journal event (`qcloud_events.event_type`) is which webhook event. The other journal events
 * (retried, stalled, removed, promoted and the rest) have no webhook name and are not delivered.
 * Migration 8's trigger carries the same table as a `VALUES` list; a test keeps the two equal.
 */
export const JOURNAL_TO_WEBHOOK: Readonly<Record<string, WebhookEvent>> = {
  pushed: 'job.pushed',
  pulled: 'job.started',
  completed: 'job.completed',
  failed: 'job.failed',
  progress: 'job.progress',
};

export function isWebhookEvent(name: unknown): name is WebhookEvent {
  return typeof name === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(name);
}

/** How a delivery is retried. */
export interface DeliveryPolicy {
  /** Attempts per delivery, the first included. At least 1. */
  readonly maxAttempts: number;
  /** The wait after the first failed attempt; each further failure doubles it. */
  readonly baseDelayMs: number;
  /** The longest wait between two attempts. */
  readonly maxDelayMs: number;
}

/** Eight attempts over 63.5 minutes: 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m between them. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
};

export function resolveDeliveryPolicy(partial: Partial<DeliveryPolicy> = {}): DeliveryPolicy {
  const policy = { ...DEFAULT_DELIVERY_POLICY, ...partial };
  for (const key of ['maxAttempts', 'baseDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) {
      throw new UnsupportedOptionError(key, 'must be a positive integer');
    }
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new UnsupportedOptionError('maxDelayMs', 'must not be less than baseDelayMs');
  }
  return policy;
}

/**
 * The wait before the next attempt, after `failedAttempts` attempts of this delivery have failed:
 * `baseDelayMs` doubled for each failure after the first, never more than `maxDelayMs`. No jitter:
 * the schedule is the documented one, and what is spread is the deliveries, not the retries of one.
 */
export function webhookRetryDelayMs(failedAttempts: number, policy: DeliveryPolicy): number {
  const doublings = Math.max(0, Math.min(failedAttempts - 1, 60));
  return Math.min(policy.baseDelayMs * 2 ** doublings, policy.maxDelayMs);
}

/** What a delivery carries. It holds no job data (neither `data` nor a return value), only where and what. */
export interface DeliveryBodyInput {
  /** The delivery's id: the same on every attempt, so a receiver deduplicates on it. */
  readonly id: string;
  readonly event: DeliveredEvent;
  /** When the event happened, epoch milliseconds. */
  readonly occurredAt: number;
  readonly queue: string;
  readonly jobId: string;
  /** The job's state after the event, when the journal still has the event. */
  readonly state?: string | null;
  readonly error?: string | null;
  readonly progress?: number | null;
}

/** The JSON text that is POSTed and signed. Fields with no value are left out. */
export function deliveryBody(input: DeliveryBodyInput): string {
  const body: Record<string, unknown> = {
    id: input.id,
    event: input.event,
    timestamp: input.occurredAt,
    queue: input.queue,
    jobId: input.jobId,
  };
  if (input.state != null) body.state = input.state;
  if (input.error != null) body.error = input.error;
  if (input.progress != null) body.progress = input.progress;
  return JSON.stringify(body);
}

/** One attempt, as the delivery history records it. */
export interface AttemptRecord {
  readonly attempt: number;
  /** When the attempt started, epoch milliseconds. */
  readonly at: number;
  readonly durationMs: number;
  /** The receiver's status, or null when none came back (refused, timed out, blocked). */
  readonly statusCode: number | null;
  /** Why the attempt did not succeed, or null when it did. Short; never a response body. */
  readonly error: string | null;
}

export type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';

/** Longest `last_error` a delivery keeps, in characters. */
export const WEBHOOK_ERROR_CHARS = 500;

/** Attempts a delivery's history keeps; the oldest are dropped past it. */
export const WEBHOOK_HISTORY_ENTRIES = 20;

/** The header names of a delivery, so the sender and the receiver documentation cannot drift apart. */
export const WEBHOOK_HEADERS = {
  id: 'X-Webhook-Id',
  event: 'X-Webhook-Event',
  timestamp: 'X-Webhook-Timestamp',
  attempt: 'X-Webhook-Attempt',
  signature: 'X-Webhook-Signature',
} as const;

/** Webhooks one namespace can register. */
export const MAX_WEBHOOKS = 100;

/** Longest webhook URL, in characters. */
export const MAX_WEBHOOK_URL_CHARS = 2_048;
