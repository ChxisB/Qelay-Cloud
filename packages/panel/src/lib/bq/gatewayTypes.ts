import type { WebhookDeliveryFull, WebhookDestination } from './types';

/** What the event gateway adds to a route: issues, per-route numbers, saved destinations and the edit body. */

/** Who paused a route that is off and collecting: an operator (`hold`) or the failure streak; null otherwise. */
export type WebhookPausedBy = 'operator' | 'failures' | null;

/** How an off route is paused: `hold` keeps collecting events, `ignore` does not. */
export type WebhookPauseMode = 'hold' | 'ignore';

/** Document paths offered for a dedupe key; any path of the request document (`body.id`, `headers.x-id`, …) is valid. */
export const WEBHOOK_DEDUPE_FIELDS = [
  'method',
  'body.id',
  'body.type',
  'headers.x-request-id',
] as const;

/** Drops an event whose chosen fields repeat inside the window; the first one goes. */
export interface WebhookDedupeFull {
  windowMs: number;
  fields: string[];
}

/** Holds a route's events until the next time the cron fires, read in `timezone` (an IANA name). */
export interface WebhookScheduleFull {
  cron: string;
  timezone: string;
}

/** Sends a route's due events as one request: up to `maxEvents`, stopping before `maxBytes` of body. */
export interface WebhookBatchFull {
  maxEvents: number;
  maxBytes: number;
}

export type WebhookIssueStatus = 'open' | 'acknowledged' | 'resolved' | 'ignored';
export const WEBHOOK_ISSUE_STATUSES: readonly WebhookIssueStatus[] = [
  'open',
  'acknowledged',
  'resolved',
  'ignored',
];

/** One route whose deliveries are failing. `updatedBy` is null when Qelay changed it, and for a read-only caller. */
export interface WebhookIssueFull {
  id: string;
  webhookId: string;
  webhookName: string | null;
  status: WebhookIssueStatus;
  kind: 'delivery_failed';
  openedAt: number;
  updatedAt: number;
  updatedBy: string | null;
  consecutiveFailures: number;
  alertLevel: number;
  pausedBy: WebhookPausedBy;
}

export interface WebhookIssuesQuery {
  status?: WebhookIssueStatus;
  webhook?: string;
  limit?: number;
  before?: string;
}

export interface WebhookIssuesPage {
  issues: WebhookIssueFull[];
  /** The `before` of the next page; null on the last one. */
  next: string | null;
  /** Every status's count, whichever one the page lists. */
  counts: Record<WebhookIssueStatus, number>;
}

export interface WebhookGroupBucketFull {
  from: number;
  delivered: number;
  failed: number;
  pending: number;
}

/** One route's numbers over the window: counts and a trend, no latency. */
export interface WebhookGroupStatFull {
  webhookId: string;
  delivered: number;
  failed: number;
  pending: number;
  failureRatio: number | null;
  backlog: number;
  oldestPendingAt: number | null;
  buckets: WebhookGroupBucketFull[];
}

export interface WebhookGroupStatsFull {
  since: number;
  until: number;
  bucketMs: number;
  groups: WebhookGroupStatFull[];
}

export interface WebhookGroupStatsQuery {
  since: number;
  until: number;
  buckets?: number;
}

/** A named address that connections are made from. The kind is fixed at creation. */
export interface DestinationFull {
  id: string;
  name: string;
  kind: WebhookDestination;
  /** For a read-only caller only its origin (see `urlRedacted`). Empty for a queue destination. */
  url: string;
  urlRedacted: boolean;
  target: string | null;
  /** The connections made from it. */
  connections: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddDestinationBody {
  name: string;
  kind: WebhookDestination;
  url?: string;
  target?: string;
}

/** The keys present are set; the address key must fit the destination's kind. */
export interface DestinationPatchBody {
  name?: string;
  url?: string;
  target?: string;
}

/** `PATCH /webhooks/:id`: the keys present are set and `null` clears all but `source`. */
export interface WebhookPatchBody {
  name?: string | null;
  description?: string | null;
  source?: string;
  filter?: Record<string, unknown> | null;
  shape?: Record<string, unknown> | null;
  delayMs?: number | null;
  dedupe?: WebhookDedupeFull | null;
  schedule?: WebhookScheduleFull | null;
  batch?: WebhookBatchFull | null;
}

export type SourceVerificationKind = 'none' | 'hmac' | 'basic' | 'api_key';
export const SOURCE_VERIFICATION_KINDS: readonly SourceVerificationKind[] = [
  'none',
  'hmac',
  'basic',
  'api_key',
];

/** An inbound source: the address a sender posts to. Its token and secret are shown once, when they are made. */
export interface SourceFull {
  id: string;
  name: string;
  enabled: boolean;
  verification: {
    kind: SourceVerificationKind;
    /** `hmac` and `api_key`: the header that carries the signature or the key. */
    header: string | null;
    /** `basic`: the user name. */
    username: string | null;
  };
  signed: boolean;
  /** While a rotated-out secret still verifies beside the new one: when it stops. */
  previousSecretUntil: number | null;
  /** Rejected requests counted and not stored, for being over the per-minute cap. */
  rejectedDropped: number;
  createdAt: number;
  updatedAt: number;
}

/** What a create or a rotation answers: the source, and the token or secret it made (null when it made none). */
export interface SourceIssued {
  source: SourceFull;
  token: string | null;
  secret: string | null;
}

export interface AddSourceBody {
  name: string;
  verification?: { kind: SourceVerificationKind; header?: string; username?: string };
  /** Left out, the server makes one for a source that verifies. */
  secret?: string;
}

export interface SourcePatchBody {
  name?: string;
  enabled?: boolean;
}

export type RequestStatus = 'accepted' | 'rejected';

/** One request a source took, without its headers, query or body. */
export interface RequestFull {
  id: string;
  sourceId: string;
  receivedAt: number;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  contentType: string | null;
  status: RequestStatus;
  /** Why a rejected request was refused. */
  cause: string | null;
  bodyBytes: number | null;
}

/** A request whole, with the deliveries it made. `body` is null for a rejected request and for a read-only caller. */
export interface RequestDetailFull extends RequestFull {
  headers: Record<string, string>;
  query: Record<string, string>;
  body: { encoding: 'utf8' | 'base64'; data: string; bytes: number } | null;
  bodyRedacted: boolean;
  deliveries: Array<WebhookDeliveryFull & { via: WebhookDestination }>;
}

export interface RequestsQuery {
  source?: string;
  status?: RequestStatus;
  before?: string;
  limit?: number;
}

export interface RequestsPage {
  requests: RequestFull[];
  /** The `before` of the next page; null on the last one. */
  next: string | null;
}

/** What a replay made: the source's routes now, and the deliveries queued (a filter drops some). */
export interface ReplayResult {
  routes: number;
  deliveries: number;
}
