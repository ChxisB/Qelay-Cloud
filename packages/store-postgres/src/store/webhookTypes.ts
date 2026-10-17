import type {
  AttemptRecord,
  DeliveredEvent,
  DeliveryStatus,
  WebhookEvent,
} from '@qelay-cloud/core';

/** What an operator registers. */
export interface WebhookSpec {
  /** Where deliveries are POSTed. The store checks only the length: the address rules are `core`'s `validateWebhookUrl`. */
  readonly url: string;
  /** At least one. Duplicates are merged. */
  readonly events: readonly WebhookEvent[];
  /** Only this queue's events. Null or omitted: every queue's. */
  readonly queue?: string | null;
  /**
   * The signing secret, in the clear and only here: the store seals it (`webhookKey`) and nothing
   * reads it back to a caller except the sender's `claimDue`. Null or omitted: the webhook is unsigned.
   */
  readonly secret?: string | null;
  /** Default true. */
  readonly enabled?: boolean;
}

/** A webhook as listings show it. The secret is never part of it, sealed or not: `signed` says there is one. */
export interface WebhookRecord {
  readonly id: string;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly queue: string | null;
  readonly signed: boolean;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: number;
  /** When the last attempt to deliver to it started. */
  readonly lastTriggered: number | null;
  /** Deliveries that got a 2xx. */
  readonly successCount: number;
  /** Deliveries that ran out of attempts or out of time. */
  readonly failureCount: number;
}

export interface DeliveryRecord {
  /** The same on every attempt: what a receiver deduplicates on. */
  readonly id: string;
  readonly webhookId: string;
  readonly event: DeliveredEvent;
  readonly queue: string;
  readonly jobId: string;
  readonly occurredAt: number;
  readonly status: DeliveryStatus;
  /** Attempts started, including ones whose result was never recorded. */
  readonly attempts: number;
  /** When the next attempt is due (for `sending`: when the claim lapses). */
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  /** The latest attempts, oldest first, at most `WEBHOOK_HISTORY_ENTRIES`. */
  readonly history: readonly AttemptRecord[];
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

export interface DeliveryPage {
  readonly items: readonly DeliveryRecord[];
  /** Pass as `before` for the next (older) page; null on the last one. */
  readonly next: string | null;
}

export interface DeliveryQuery {
  readonly limit?: number;
  /** A delivery id: only older deliveries. */
  readonly before?: string;
  readonly status?: DeliveryStatus;
}

export type RetryResult =
  | { readonly outcome: 'retried'; readonly delivery: DeliveryRecord }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_failed'; readonly status: DeliveryStatus };

export interface ClaimOptions {
  /** Most deliveries one claim takes, over all webhooks. */
  readonly limit: number;
  /** How long a claimed delivery is the claimer's: past it another claim takes it again. */
  readonly leaseMs: number;
  /** Most attempts one webhook gets in a fixed minute. */
  readonly ratePerMinute: number;
}

/** One delivery attempt the caller now owns, with what it needs to make it. */
export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly url: string;
  /** The attempt's number, from 1; it is what `record` is fenced by. */
  readonly attempt: number;
  readonly event: DeliveredEvent;
  readonly queue: string;
  readonly jobId: string;
  readonly occurredAt: number;
  /** From the journal, when the event is still in it. */
  readonly state: string | null;
  readonly error: string | null;
  readonly progress: number | null;
  /** The signing secret, opened; null for an unsigned webhook (and when `secretUnreadable`). */
  readonly secret: string | null;
  /** The webhook is signed but its secret could not be opened (no key, or the wrong one): send nothing. */
  readonly secretUnreadable: boolean;
}

/** What one attempt came to. */
export interface AttemptOutcome {
  readonly deliveryId: string;
  /** `ClaimedDelivery.webhookId`: the webhook's row is locked before its deliveries. */
  readonly webhookId: string;
  /** `ClaimedDelivery.attempt`. */
  readonly attempt: number;
  /** The receiver answered 2xx. */
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface RecordSummary {
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  /** Outcomes the delivery no longer accepted: its claim had lapsed and another attempt owns it, or it is gone. */
  readonly stale: number;
}
