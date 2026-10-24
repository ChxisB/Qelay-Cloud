import type { WebhookBatchFull, WebhookDedupeFull, WebhookScheduleFull } from './gatewayTypes';
export interface DbFilter {
  column: string;
  op: 'contains' | 'eq' | 'ne';
  value: string;
}

export type DbRowId = number | string;

export interface DbRowsPage {
  ok: boolean;
  table: string;
  columns: string[];
  rows: unknown[][];
  rowids: (DbRowId | null)[];
  truncatedCells: boolean[][];
  total: number;
  limit: number;
  offset: number;
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DbFilter | null;
}

export interface DbExportRequest {
  table: string;
  orderBy?: string;
  dir: 'asc' | 'desc';
  filter?: DbFilter;
}

export type DbExportCap = 'rows' | 'bytes' | null;

export interface DbCsvExportResult {
  table: string;
  content: Uint8Array<ArrayBuffer>;
  rowCount: number;
  bytes: number;
  cap: DbExportCap;
}

export type Backoff = number | { type: 'fixed' | 'exponential'; delay: number };

/** Safe repeat subset; pattern repeats belong to the Cron API in Qelay. */
export interface RepeatOptions {
  every: number;
  limit?: number;
}

export interface DedupOptions {
  ttl?: number;
  extend?: boolean;
  replace?: boolean;
}

export interface HeapMB {
  heapUsed: number;
  heapTotal: number;
  rss: number;
}

export interface AddJobBody {
  name?: string;
  data: unknown;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: Backoff;
  timeout?: number;
  jobId?: string;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  durable?: boolean;
  ttl?: number;
  uniqueKey?: string;
  lifo?: boolean;
  tags?: string[];
  groupId?: string;
  /** Atomic pending-depth admission cap for a group (Qelay). */
  groupMaxSize?: number;
  dependsOn?: string[];
  repeat?: RepeatOptions;
}

export interface BulkJobBody extends AddJobBody {
  stallTimeout?: number;
  dedup?: DedupOptions;
  stackTraceLimit?: number;
  timestamp?: number;
}

export interface CronJobOptions {
  maxAttempts?: number;
  backoff?: Backoff;
  timeout?: number;
  delay?: number;
  stallTimeout?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

export interface CreateCronBody {
  name: string;
  jobName?: string;
  queue: string;
  data?: unknown;
  schedule?: string;
  repeatEvery?: number;
  priority?: number;
  timezone?: string;
  skipIfNoWorker?: boolean;
  preventOverlap?: boolean;
  maxLimit?: number;
  immediately?: boolean;
  skipMissedOnRestart?: boolean;
  uniqueKey?: string;
  dedup?: DedupOptions;
  jobOptions?: CronJobOptions;
}

export type WebhookDestination = 'http' | 'queue';

/** A route: `http` needs a `url`; `queue` needs a `target` queue and no `url`. Every route reads from one inbound `source`. */
export interface AddWebhookBody {
  destination?: WebhookDestination;
  url?: string;
  target?: string;
  /** Takes the kind and address from a saved destination: no `destination`, `url` or `target` with it. */
  destinationId?: string;
  source: string;
  secret?: string;
  enabled?: boolean;
  filter?: Record<string, unknown>;
  shape?: Record<string, unknown>;
  name?: string;
  description?: string;
  delayMs?: number;
  dedupe?: WebhookDedupeFull;
  schedule?: WebhookScheduleFull;
  batch?: WebhookBatchFull;
}

export type WebhookDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';

export interface WebhookAttemptFull {
  attempt: number;
  at: number;
  durationMs: number;
  /** The receiver's status; null when none came back. */
  statusCode: number | null;
  /** A short reason in words, never a response body. */
  error: string | null;
}

export interface WebhookDeliveryFull {
  id: string;
  webhookId: string;
  event: string;
  /** The request the delivery was made from; null for a test delivery. */
  requestId?: string | null;
  /** The job a delivered queue route made in its target queue; null for http and until it is delivered. */
  routedJobId?: string | null;
  occurredAt: number;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  history: WebhookAttemptFull[];
  createdAt: number;
  finishedAt: number | null;
}

export interface WebhookDeliveriesQuery {
  limit?: number;
  before?: string;
  status?: WebhookDeliveryStatus;
}

/** The Events screen's feed: every route's deliveries, newest first. */
export interface AllWebhookDeliveriesQuery extends WebhookDeliveriesQuery {
  webhook?: string;
  /** Epoch ms: only events at or after / before these. */
  since?: number;
  until?: number;
}

export interface WebhookStatsQuery {
  since: number;
  until: number;
  webhook?: string;
  buckets?: number;
}

export interface WebhookStatsBucketFull {
  from: number;
  delivered: number;
  failed: number;
  pending: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface WebhookStatsFull {
  since: number;
  until: number;
  bucketMs: number;
  delivered: number;
  failed: number;
  pending: number;
  failureRatio: number | null;
  avgAttempts: number | null;
  /** Waiting or being sent now, whatever the window. */
  backlog: number;
  oldestPendingAt: number | null;
  latency: { avgMs: number; p95Ms: number; maxMs: number } | null;
  buckets: WebhookStatsBucketFull[];
}
