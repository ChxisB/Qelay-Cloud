import type { WebhookDedupeFull, WebhookPausedBy } from './bq/gatewayTypes';

export interface JobFull {
  id: string;
  queue?: string;
  /** First-class job name (Qelay protocol v3). */
  name?: string;
  data?: unknown;
  /** Terminal value embedded by current job read/list endpoints. */
  returnvalue?: unknown;
  /** Most recent terminal failure message embedded by current job reads. */
  failedReason?: string;
  /** Legacy dashboard alias; new code should prefer returnvalue. */
  result?: unknown;
  priority?: number;
  createdAt?: number;
  runAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  attempts?: number;
  maxAttempts?: number;
  backoff?: number;
  backoffConfig?: { type: 'fixed' | 'exponential'; delay: number; maxDelay?: number } | null;
  timeout?: number | null;
  ttl?: number | null;
  progress?: number;
  progressMessage?: string | null;
  stacktrace?: string[] | null;
  customId?: string | null;
  parentId?: string | null;
  childrenIds?: string[];
  /** The root of the flow this job belongs to; null for a job in no flow. */
  flowRoot?: string | null;
  dependsOn?: string[];
  tags?: string[];
  groupId?: string | null;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  lastHeartbeat?: number;
  stallCount?: number;
  state?: string;
  /**
   * The row's version. A job action sends it back as `expectedVersion`, so an action aimed at
   * what was read is refused (409 `version_conflict`) when another operator changed the job.
   */
  version?: number;
  timeline?: Array<{
    state: string;
    timestamp: number;
    worker?: string;
    error?: string;
    attempt?: number;
  }>;
  [key: string]: unknown;
}

export interface QueueCountsFull {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  'waiting-children': number;
  paused: number;
  [key: string]: number;
}

/** One entry of GET /queues/summary — all queues' counts in a single call. */
export interface QueueSummaryFull {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    prioritized: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

export interface DlqEntryFull {
  job: JobFull;
  enteredAt: number;
  reason: string;
  error: string | null;
  attempts?: Array<{
    attempt: number;
    startedAt: number;
    failedAt: number;
    reason: string;
    error: string | null;
    duration: number;
  }>;
  retryCount?: number;
  lastRetryAt?: number | null;
  nextRetryAt?: number | null;
  expiresAt?: number | null;
}

export interface DlqStatsFull {
  total: number;
  byReason: Record<string, number>;
  byQueue: Record<string, number>;
  pendingRetry: number;
  expired: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export interface WebhookFull {
  id: string;
  /** `http` POSTs to `url`; `queue` adds a job to `target`. */
  destination: 'http' | 'queue';
  /** The address; for a read-only caller only its origin (see `urlRedacted`). Empty for a queue route. */
  url: string;
  /** The queue a queue route adds jobs to; null for http. */
  target: string | null;
  urlRedacted: boolean;
  events: string[];
  queue: string | null;
  /** Whether deliveries are signed. The secret itself is write-only: no response carries it. */
  signed: boolean;
  createdAt: number;
  lastTriggered: number | null;
  successCount: number;
  failureCount: number;
  enabled: boolean;
  /** Failed deliveries in a row; `alertLevel` (0 to 4) is how far that has come toward the pause. */
  consecutiveFailures: number;
  alertLevel: number;
  /** Set when the route was paused after repeated failures; it is then not enabled. */
  disabledReason: string | null;
  disabledAt: number | null;
  /** Rules, as the server holds them: only events that pass `filter` go, in the shape `shape` says. */
  filter: Record<string, unknown> | null;
  shape: Record<string, unknown> | null;
  /** What the operator calls it, and a note; null for none. */
  name: string | null;
  description: string | null;
  /** A delivery is due this many ms after its event; null for at once. */
  delayMs: number | null;
  dedupe: WebhookDedupeFull | null;
  /** Who paused a route that is off and collecting; null when running or disabled by hand (ignoring events). */
  pausedBy: WebhookPausedBy;
  /** The saved destination the address was copied from; null when it was given directly. */
  destinationId: string | null;
}

export interface WorkerFull {
  id: string;
  name: string;
  queues: string[];
  concurrency: number;
  hostname: string;
  pid: number;
  status: 'active' | 'stale';
  registeredAt: number;
  lastSeen: number;
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
  currentJob: string | null;
  uptime: number;
}

export interface CronFull {
  name: string;
  /** Name assigned to every job spawned by this scheduler. */
  jobName?: string;
  queue: string;
  schedule: string | null;
  repeatEvery: number | null;
  nextRun: number;
  executions: number;
  maxLimit: number | null;
  timezone: string | null;
  uniqueKey?: string | null;
  dedup?: { ttl?: number; extend?: boolean; replace?: boolean } | null;
  skipMissedOnRestart?: boolean;
  skipIfNoWorker?: boolean;
  preventOverlap?: boolean;
  jobOptions?: {
    maxAttempts?: number;
    backoff?: number | { type: 'fixed' | 'exponential'; delay: number };
    timeout?: number;
    delay?: number;
    stallTimeout?: number;
    removeOnComplete?: boolean;
    removeOnFail?: boolean;
  } | null;
}

export interface StorageStatusFlat {
  diskFull?: boolean;
  error?: string | null;
  since?: number | null;
}

export interface StallConfig {
  enabled: boolean;
  stallInterval: number;
  maxStalls: number;
  gracePeriod: number;
}

export interface DlqConfig {
  autoRetry: boolean;
  autoRetryInterval: number;
  maxAutoRetries: number;
  maxAge: number | null;
  maxEntries: number;
}

// ---- Control agent ----
export type {
  DbStats,
  ServerConfig,
  ServerConfigSnapshot,
  ServerLogLine,
  ServerManagementMode,
  ServerRunStatus,
  ServerStatus,
} from './controlTypes';
