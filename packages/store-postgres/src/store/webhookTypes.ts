import type {
  AttemptRecord,
  DeliveredEvent,
  DeliveryStatus,
  WebhookBatch,
  WebhookDedupe,
  WebhookDestination,
  WebhookFilter,
  WebhookSchedule,
  WebhookShape,
} from '@qelay-cloud/core';

/** What an operator registers. */
export interface WebhookSpec {
  /** `http` (the default) POSTs to `url`; `queue` adds a job to `target` (D11). */
  readonly destination?: WebhookDestination;
  /** Where deliveries are POSTed; `http` only. The store checks only the length: the address rules are `core`'s `validateWebhookUrl`. */
  readonly url?: string;
  /** The queue a `queue` route adds jobs to, in this namespace. */
  readonly target?: string | null;
  /**
   * Makes the webhook from a saved destination: its kind and address are copied, so the spec gives this or `destination`,
   * `url` and `target`, not both. A change to the destination reaches the webhook; removing it is refused while it is used.
   */
  readonly destinationId?: string | null;
  /** The inbound source whose requests the route delivers (D14), by id. It must exist; a route without one is refused. */
  readonly source?: string | null;
  /**
   * The signing secret, in the clear and only here: the store seals it (`webhookKey`) and nothing
   * reads it back to a caller except the sender's `claimDue`. Null or omitted: the store makes one
   * (`WebhookIssued.secret`), or, with no `webhookKey`, the webhook is unsigned.
   */
  readonly secret?: string | null;
  /** Default true. */
  readonly enabled?: boolean;
  /**
   * Only requests that pass it are delivered (`validateFilter`). Null or omitted: every request of the source.
   */
  readonly filter?: WebhookFilter | null;
  /** The body template (`validateShape`). Null or omitted: the request's own body. */
  readonly shape?: WebhookShape | null;
  /** What the operator calls it (at most 80 characters) and a note (at most 500). Blank or null: none. */
  readonly name?: string | null;
  readonly description?: string | null;
  /** A delivery is made when the request is taken, and is due this many milliseconds later (1 s to 1 h). */
  readonly delayMs?: number | null;
  /** Drops a request whose chosen fields repeat inside the window (`validateDedupe`). */
  readonly dedupe?: WebhookDedupe | null;
  /**
   * Holds the route's deliveries until the next time the cron fires (D15): due at the first fire at or after the
   * request plus `delayMs`. Null or omitted: due at once. Either destination.
   */
  readonly schedule?: WebhookSchedule | null;
  /** Sends the route's due deliveries as one request (D15); `http` routes only. Null or omitted: one request each. */
  readonly batch?: WebhookBatch | null;
}

/**
 * What `update` may change. A key that is present is set (null clears it); an absent one is left alone.
 * The destination and the secret are not editable: remove and add, or rotate.
 */
export interface WebhookPatch {
  readonly name?: string | null;
  readonly description?: string | null;
  /** Moves the route to another source. */
  readonly source?: string;
  readonly filter?: WebhookFilter | null;
  readonly shape?: WebhookShape | null;
  readonly delayMs?: number | null;
  readonly dedupe?: WebhookDedupe | null;
  /** A schedule or batch applies to deliveries made after the change; ones already waiting keep their due time. */
  readonly schedule?: WebhookSchedule | null;
  readonly batch?: WebhookBatch | null;
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
  /** The inbound source the route listens to; null for a route from before sources, which is disabled until it gets one. */
  readonly source: string | null;
  readonly signed: boolean;
  readonly enabled: boolean;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly delayMs: number | null;
  readonly dedupe: WebhookDedupe | null;
  readonly schedule: WebhookSchedule | null;
  readonly batch: WebhookBatch | null;
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
  /** The inbound request it carries (D14); null for a test delivery. */
  readonly requestId: string | null;
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
  /** The batch the latest attempt went out in (D15); null when it was sent alone. */
  readonly batchId: string | null;
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
  /**
   * Most requests one claim makes ready, over all webhooks: a delivery of a plain route is one, and the deliveries a batch
   * route contributes (up to its `maxEvents`) are one together. A claim returns the deliveries, so it can return more.
   */
  readonly limit: number;
  /** How long a claimed delivery is the claimer's: past it another claim takes it again. */
  readonly leaseMs: number;
  /** Most requests one webhook gets in a fixed minute: a batch counts once. */
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
  readonly occurredAt: number;
  /**
   * The bytes to POST, when the route's shape made them: null means the request's own bytes, or the test document. The
   * empty string means the shaped body was too large to make: nothing can be sent.
   */
  readonly body: string | null;
  /** The inbound request this delivery carries (D14), or null. */
  readonly requestId: string | null;
  /** The request's own bytes, when it has no shaped `body`; null if it has none or the request was removed. */
  readonly requestBody: Uint8Array | null;
  /** The request's `Content-Type`; null when it had none. */
  readonly requestContentType: string | null;
  /** The signing secret, opened; null for an unsigned webhook (and when `secretUnreadable`). */
  readonly secret: string | null;
  /** The secret before the last rotation while it still signs; null otherwise. */
  readonly previousSecret: string | null;
  /** The webhook is signed but its secret could not be opened (no key, or the wrong one): send nothing. */
  readonly secretUnreadable: boolean;
  /**
   * True for a delivery of a batch route (D15): the ones of this claim with the same `webhookId` go out together, in one
   * request. Absent or false: this delivery is sent alone, which is all a sender that predates batches does.
   */
  readonly batched?: boolean;
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
  /**
   * The batch this delivery went out in, when it did (D15): stored on the delivery and in its history entry. The members of
   * one batch that are retried share one retry time.
   */
  readonly batchId?: string | null;
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
