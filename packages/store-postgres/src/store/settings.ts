import { DEFAULT_AUDIT_RETENTION_MS, DEFAULT_MAX_AUDIT_ENTRIES } from './audit';
import { DEFAULT_MAX_COMPLETED_JOBS } from './completions';
import { DEFAULT_EVENT_RETENTION_MS, DEFAULT_MAX_QUEUE_EVENTS } from './eventRetention';
import { DEFAULT_MAX_JOB_LOGS, MAX_JOB_LOGS } from './logs';
import { DEFAULT_MAX_METRIC_BUCKETS } from './metrics';
import { DEFAULT_WEBHOOK_KEEP_MS } from './webhookRetention';
import { DEFAULT_WORKER_ACTIVE_MS, DEFAULT_WORKER_EXPIRE_MS } from './workers';

/** The store options that are plain numbers: each is floored and kept at least 1 (0 for the metric buckets). */
export interface StoreSettingsOptions {
  /** Minutes of per-minute metric buckets kept (default 20,160, fourteen days). 0: lifetime totals only. */
  readonly maxMetricBuckets?: number;
  /** A worker with no heartbeat for this long no longer counts as active (a cron's `skipIfNoWorker`). Default 30,000. */
  readonly workerActiveMs?: number;
  /** A worker with no heartbeat for this long is deleted by the tick. Default 90,000. */
  readonly workerExpireMs?: number;
  /** Events the journal keeps per queue; past it the tick deletes the oldest, and readers are told. Default 10,000. */
  readonly maxQueueEvents?: number;
  /** How long the journal keeps an event. Default 24 hours. */
  readonly eventRetentionMs?: number;
  /** Log lines kept per job; adding one past it deletes the oldest. Default 100, at most 1,000. */
  readonly maxJobLogs?: number;
  /** Newest completions whose records survive the job's removal (`pruneCompletions`). Default 50,000. */
  readonly maxCompletedJobs?: number;
  /** How long the operator audit log keeps an entry. Default 90 days. */
  readonly auditRetentionMs?: number;
  /** Entries the operator audit log keeps; past it the oldest go. Default 100,000. */
  readonly maxAuditEntries?: number;
  /**
   * How long a finished webhook delivery stays readable. Default two days. A day partition is dropped
   * once its day ended this long ago, so the shortest value among the processes that tick decides.
   */
  readonly webhookKeepMs?: number;
}

export interface StoreSettings {
  readonly maxMetricBuckets: number;
  readonly workerActiveMs: number;
  readonly workerExpireMs: number;
  readonly maxQueueEvents: number;
  readonly eventRetentionMs: number;
  readonly maxJobLogs: number;
  readonly maxCompletedJobs: number;
  readonly auditRetentionMs: number;
  readonly maxAuditEntries: number;
  readonly webhookKeepMs: number;
}

const whole = (value: number | undefined, fallback: number, least: number): number =>
  Math.max(least, Math.floor(value ?? fallback));

/** Applies the defaults and the floors, so no store operation re-checks them. */
export function resolveSettings(options: StoreSettingsOptions): StoreSettings {
  return {
    maxMetricBuckets: whole(options.maxMetricBuckets, DEFAULT_MAX_METRIC_BUCKETS, 0),
    workerActiveMs: whole(options.workerActiveMs, DEFAULT_WORKER_ACTIVE_MS, 1),
    workerExpireMs: whole(options.workerExpireMs, DEFAULT_WORKER_EXPIRE_MS, 1),
    maxQueueEvents: whole(options.maxQueueEvents, DEFAULT_MAX_QUEUE_EVENTS, 1),
    eventRetentionMs: whole(options.eventRetentionMs, DEFAULT_EVENT_RETENTION_MS, 1),
    maxJobLogs: Math.min(MAX_JOB_LOGS, whole(options.maxJobLogs, DEFAULT_MAX_JOB_LOGS, 1)),
    maxCompletedJobs: whole(options.maxCompletedJobs, DEFAULT_MAX_COMPLETED_JOBS, 1),
    auditRetentionMs: whole(options.auditRetentionMs, DEFAULT_AUDIT_RETENTION_MS, 1),
    maxAuditEntries: whole(options.maxAuditEntries, DEFAULT_MAX_AUDIT_ENTRIES, 1),
    webhookKeepMs: whole(options.webhookKeepMs, DEFAULT_WEBHOOK_KEEP_MS, 1),
  };
}
