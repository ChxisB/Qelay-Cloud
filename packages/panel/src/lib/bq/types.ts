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

export interface AddWebhookBody {
  url: string;
  events: string[];
  queue?: string;
  secret?: string;
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
  queue: string;
  jobId: string;
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

export const WEBHOOK_EVENTS = [
  'job.pushed',
  'job.started',
  'job.completed',
  'job.failed',
  'job.progress',
] as const;
