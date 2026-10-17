import type { JobFull } from './panel-bq-types';

// Verbatim copy of `DlqEntryFull`, `DlqStatsFull`, `WorkerFull`, `CronFull`, `StallConfig` and
// `DlqConfig` of `src/lib/bqTypes.ts` and of `CronJobOptions` and `CreateCronBody` of
// `src/lib/bq/types.ts` from ../qelay-control-panel (MIT, see docs/PORTING.md), taken so the contract
// tests can check what the Control API sends for the DLQ, cron and worker pages against what the
// panel reads. Do not edit it: when task 33 exists the panel's types come from a shared package and
// this file is deleted.
//
//   panel commit:  8ebf9328950a23a2f2687115a0ec15e66b7659bd (2026-10-09)
//   sha256 of the copied blocks (joined by one blank line): 254d8062071dee60638fae9251fbac1e861915252d624a7f2436276e058add62
//   `Backoff` and `DedupOptions` are restated below exactly as `src/lib/bq/types.ts` declares them
//   (lines 41 and 49), as importing them would copy the rest of that file.
//
export type Backoff = number | { type: 'fixed' | 'exponential'; delay: number };
export interface DedupOptions {
  ttl?: number;
  extend?: boolean;
  replace?: boolean;
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
