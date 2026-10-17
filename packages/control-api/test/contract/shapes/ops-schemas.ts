import { z } from 'zod';
import { jobFullSchema } from './jobs-schemas';
import type {
  CronFull,
  DlqConfig,
  DlqEntryFull,
  DlqStatsFull,
  StallConfig,
  WorkerFull,
} from './panel-ops-types';

/**
 * Runtime schemas for what the panel's DLQ, cron, worker and queue-settings pages read, checked against
 * the panel's own types by `satisfies` as in `jobs-schemas.ts`. Extra fields are allowed, as the panel
 * allows them.
 */
const count = z.number();
const nullableCount = count.nullable();
const nullableText = z.string().nullable();

export const dlqEntrySchema = z
  .object({
    job: jobFullSchema,
    enteredAt: count,
    reason: z.string(),
    error: nullableText,
    attempts: z
      .array(
        z.object({
          attempt: count,
          startedAt: count,
          failedAt: count,
          reason: z.string(),
          error: nullableText,
          duration: count,
        })
      )
      .optional(),
    retryCount: count.optional(),
    lastRetryAt: nullableCount.optional(),
    nextRetryAt: nullableCount.optional(),
    expiresAt: nullableCount.optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<DlqEntryFull>;

export const dlqStatsSchema = z.object({
  total: count,
  byReason: z.record(z.string(), count),
  byQueue: z.record(z.string(), count),
  pendingRetry: count,
  expired: count,
  oldestEntry: nullableCount,
  newestEntry: nullableCount,
}) satisfies z.ZodType<DlqStatsFull>;

export const workerSchema = z.object({
  id: z.string(),
  name: z.string(),
  queues: z.array(z.string()),
  concurrency: count,
  hostname: z.string(),
  pid: count,
  status: z.enum(['active', 'stale']),
  registeredAt: count,
  lastSeen: count,
  activeJobs: count,
  processedJobs: count,
  failedJobs: count,
  currentJob: nullableText,
  uptime: count,
}) satisfies z.ZodType<WorkerFull>;

const cronBackoff = z.union([
  count,
  z.object({ type: z.enum(['fixed', 'exponential']), delay: count }),
]);

export const cronSchema = z.object({
  name: z.string(),
  jobName: z.string().optional(),
  queue: z.string(),
  schedule: nullableText,
  repeatEvery: nullableCount,
  nextRun: count,
  executions: count,
  maxLimit: nullableCount,
  timezone: nullableText,
  uniqueKey: nullableText.optional(),
  dedup: z
    .object({
      ttl: count.optional(),
      extend: z.boolean().optional(),
      replace: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  skipMissedOnRestart: z.boolean().optional(),
  skipIfNoWorker: z.boolean().optional(),
  preventOverlap: z.boolean().optional(),
  jobOptions: z
    .object({
      maxAttempts: count.optional(),
      backoff: cronBackoff.optional(),
      timeout: count.optional(),
      delay: count.optional(),
      stallTimeout: count.optional(),
      removeOnComplete: z.boolean().optional(),
      removeOnFail: z.boolean().optional(),
    })
    .nullable()
    .optional(),
}) satisfies z.ZodType<CronFull>;

export const stallConfigSchema = z.object({
  enabled: z.boolean(),
  stallInterval: count,
  maxStalls: count,
  gracePeriod: count,
}) satisfies z.ZodType<StallConfig>;

export const dlqConfigSchema = z.object({
  autoRetry: z.boolean(),
  autoRetryInterval: count,
  maxAutoRetries: count,
  maxAge: nullableCount,
  maxEntries: count,
}) satisfies z.ZodType<DlqConfig>;
