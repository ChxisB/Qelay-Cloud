import type { WebhookDestination } from './types';

/** What the event gateway adds to a route: issues, per-route numbers, saved destinations and the edit body. */

/** Who paused a route that is off and collecting: an operator (`hold`) or the failure streak; null otherwise. */
export type WebhookPausedBy = 'operator' | 'failures' | null;

/** How an off route is paused: `hold` keeps collecting events, `ignore` does not. */
export type WebhookPauseMode = 'hold' | 'ignore';

export const WEBHOOK_DEDUPE_FIELDS = ['event', 'queue', 'jobId', 'state', 'error'] as const;

/** Drops an event whose chosen fields repeat inside the window; the first one goes. */
export interface WebhookDedupeFull {
  windowMs: number;
  fields: string[];
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

/** `PATCH /webhooks/:id`: the keys present are set and `null` clears all but `events`. */
export interface WebhookPatchBody {
  name?: string | null;
  description?: string | null;
  events?: string[];
  filter?: Record<string, unknown> | null;
  shape?: Record<string, unknown> | null;
  delayMs?: number | null;
  dedupe?: WebhookDedupeFull | null;
}
