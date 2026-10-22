import type {
  AttemptRecord,
  DeliveredEvent,
  DeliveryStatus,
  WebhookDedupe,
  WebhookDestination,
  WebhookEvent,
  WebhookFilter,
  WebhookShape,
} from '@qelay-cloud/core';

/** What an operator registers. */
export interface WebhookSpec {
  /** `http` (the default) POSTs to `url`; `queue` adds a job to `target` (D11). */
  readonly destination?: WebhookDestination;
  /** Where deliveries are POSTed; `http` only. The store checks only the length: the address rules are `core`'s `validateWebhookUrl`. */
  readonly url?: string;
  /** The queue a `queue` route adds jobs to, in this namespace; needs a source `queue`, and is refused when it would make a loop. */
  readonly target?: string | null;
  /**
   * Makes the webhook from a saved destination: its kind and address are copied, so the spec gives this or `destination`,
   * `url` and `target`, not both. A change to the destination reaches the webhook; removing it is refused while it is used.
   */
  readonly destinationId?: string | null;
  /** At least one. Duplicates are merged. */
  readonly events: readonly WebhookEvent[];
  /** Only this queue's events. Null or omitted: every queue's. */
  readonly queue?: string | null;
  /**
   * The signing secret, in the clear and only here: the store seals it (`webhookKey`) and nothing
   * reads it back to a caller except the sender's `claimDue`. Null or omitted: the store makes one
   * (`WebhookIssued.secret`), or, with no `webhookKey`, the webhook is unsigned.
   */
  readonly secret?: string | null;
  /** Default true. */
  readonly enabled?: boolean;
  /**
   * Only events that pass it are delivered (`validateFilter`). Needs the delivery writer on: the
   * trigger cannot evaluate it. Null or omitted: every event the webhook subscribes to.
   */
  readonly filter?: WebhookFilter | null;
  /** The body template (`validateShape`); same condition. Null or omitted: the default body. */
  readonly shape?: WebhookShape | null;
  /** What the operator calls it (at most 80 characters) and a note (at most 500). Blank or null: none. */
  readonly name?: string | null;
  readonly description?: string | null;
  /** A delivery is made when the event is, and is due this many milliseconds later (1 s to 1 h). Writer only. */
  readonly delayMs?: number | null;
  /** Drops an event whose chosen fields repeat inside the window (`validateDedupe`). Writer only. */
  readonly dedupe?: WebhookDedupe | null;
}

/**
 * What `update` may change. A key that is present is set (null clears it, except `events`, which cannot be empty);
 * an absent one is left alone. The source queue, the destination and the secret are not editable: remove and add, or rotate.
 * A `filter`, `shape`, `delayMs` or `dedupe` needs the delivery writer, as at creation.
 */
export interface WebhookPatch {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly events?: readonly WebhookEvent[];
  readonly filter?: WebhookFilter | null;
  readonly shape?: WebhookShape | null;
  readonly delayMs?: number | null;
  readonly dedupe?: WebhookDedupe | null;
}

/** A webhook as listings show it. The secret is never part of it, sealed or not: `signed` says there is one. */
export interface WebhookRecord {
  readonly id: string;
  readonly destination: WebhookDestination;
  /** The empty string for a `queue` route. */
  readonly url: string;
  /** The queue of a `queue` route, else null. */
  readonly target: string | null;
  /** The saved destination the address was copied from, else null. */
  readonly destinationId: string | null;
  readonly events: readonly WebhookEvent[];
  readonly queue: string | null;
  readonly signed: boolean;
  readonly enabled: boolean;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly delayMs: number | null;
  readonly dedupe: WebhookDedupe | null;
  readonly createdBy: string;
  readonly createdAt: number;
  /** When the last attempt to deliver to it started. */
  readonly lastTriggered: number | null;
  /** Deliveries that got a 2xx. */
  readonly successCount: number;
  /** Deliveries that ran out of attempts or out of time. */
  readonly failureCount: number;
  /** Deliveries that ran out of attempts since the last one that got a 2xx. */
  readonly consecutiveFailures: number;
  /** 0 to 4: how far `consecutiveFailures` has come toward the pause (50, 70, 90, 100 percent). */
  readonly alertLevel: number;
  /** Set while the webhook is paused for failing: why. It is `enabled: false` and its deliveries are held. */
  readonly disabledReason: string | null;
  readonly disabledAt: number | null;
  /** While a rotated-out secret still signs beside the new one: until when (epoch ms). */
  readonly previousSecretUntil: number | null;
}

/**
 * What `create` and `rotateSecret` return: the webhook, and the secret the store made for it. That is
 * the one time it is shown; `secret` is null when the caller chose the secret or the webhook is unsigned.
 */
export interface WebhookIssued extends WebhookRecord {
  readonly secret: string | null;
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

/** Deliveries of every webhook of the namespace (the console's Events screen). */
export interface AllDeliveriesQuery extends DeliveryQuery {
  /** Only this webhook's. */
  readonly webhook?: string;
  /** Epoch milliseconds: only deliveries whose event happened at or after / before these. */
  readonly since?: number;
  readonly until?: number;
}

/** `retryFailed`: which of a webhook's failed deliveries to put back. */
export interface RetryFailedOptions {
  /** A delivery id: only older ones. */
  readonly before?: string;
  /** At most this many, newest first. Default and maximum `MAX_BULK_RETRY`. */
  readonly limit?: number;
}

export type {
  GroupBucket,
  GroupStatsQuery,
  StatsBucket,
  StatsQuery,
  WebhookGroupStat,
  WebhookGroupStats,
  WebhookStats,
} from './webhookStatsTypes';

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
  /** Where an `http` route POSTs; the empty string for a `queue` route. */
  readonly url: string;
  /** What the route delivers to (D11). A sender that predates it reads only `url`. */
  readonly destination: WebhookDestination;
  /** The queue a `queue` route adds a job to; null for `http`. */
  readonly target: string | null;
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
  /**
   * The bytes to POST, when the delivery writer shaped them: null means the default body. The empty
   * string means the shaped body was too large to make: nothing can be sent.
   */
  readonly body: string | null;
  /** The signing secret, opened; null for an unsigned webhook (and when `secretUnreadable`). */
  readonly secret: string | null;
  /** The secret before the last rotation while it still signs; null otherwise. */
  readonly previousSecret: string | null;
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
  /** The first bytes of a failed answer's body, when the sender captured them. Kept for failures only. */
  readonly response?: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface RecordSummary {
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  /** Webhooks this call paused for failing too many deliveries in a row. */
  readonly paused: number;
  /** Outcomes the delivery no longer accepted: its claim had lapsed and another attempt owns it, or it is gone. */
  readonly stale: number;
}

/** Where the delivery writer stands. */
export interface WriterState {
  /** `trigger`: the job transaction makes deliveries. `writer`: the writer does. `stopping`: switching back. */
  readonly mode: 'trigger' | 'writer' | 'stopping';
  /** The journal position the writer has consumed; null in `trigger` mode. */
  readonly commitSeq: number | null;
  readonly eventId: number | null;
}

export interface WriteOptions {
  /** Most journal events one pass reads. Default 500. */
  readonly limit?: number;
}

export interface WriteResult {
  /** False: this namespace is in `trigger` mode, or another writer holds the cursor right now. */
  readonly active: boolean;
  /** Journal events read. */
  readonly events: number;
  /** Delivery rows made (events that matched no webhook, or were delivered already, make none). */
  readonly written: number;
  /** More events are waiting: call again at once. */
  readonly more: boolean;
  /** The writer had been away longer than retention keeps events: those events were lost to webhooks. */
  readonly gap: boolean;
}
