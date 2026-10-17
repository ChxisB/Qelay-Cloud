import { z } from 'zod';
import type { JobFull, QueueCountsFull, QueueSummaryFull } from './panel-bq-types';
import type { Job, QueueDetailResponse, QueuesResponse } from './panel-types';

/**
 * Runtime schemas for what the panel's queue and job pages read, checked against the panel's own types
 * by `satisfies` as in `schemas.ts`. Extra fields are allowed, as the panel allows them.
 */
const count = z.number();
const optionalCount = count.optional();
const nullableCount = count.nullable().optional();
const optionalText = z.string().optional();
const nullableText = z.string().nullable().optional();
const textList = z.array(z.string()).optional();

export const queueCountsSchema = z
  .object({
    waiting: count,
    prioritized: count,
    delayed: count,
    active: count,
    completed: count,
    failed: count,
    'waiting-children': count,
    paused: count,
  })
  .catchall(count) satisfies z.ZodType<QueueCountsFull>;

export const queueSummaryRowSchema = z.object({
  name: z.string(),
  paused: z.boolean(),
  counts: z.object({
    waiting: count,
    prioritized: count,
    active: count,
    completed: count,
    failed: count,
    delayed: count,
  }),
}) satisfies z.ZodType<QueueSummaryFull>;

export const queuesResponseSchema = z.object({
  ok: z.boolean(),
  queues: z.array(
    z.object({
      name: z.string(),
      waiting: count,
      delayed: count,
      active: count,
      dlq: count,
      paused: z.boolean(),
    })
  ),
  total: count,
  limit: count,
  offset: count,
  timestamp: count,
}) satisfies z.ZodType<QueuesResponse>;

const jobSummary = z.object({
  id: z.string(),
  priority: count,
  createdAt: count,
  runAt: count,
  attempts: count,
  progress: count,
});

export const queueDetailSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  counts: queueCountsSchema,
  paused: z.boolean(),
  priorityCounts: z.record(z.string(), count),
  dlqPreview: z.array(
    z.object({ id: z.string(), data: z.unknown(), attempts: count, createdAt: count })
  ),
  jobs: z
    .object({
      waiting: z.array(jobSummary),
      active: z.array(jobSummary),
      delayed: z.array(jobSummary),
      paused: z.array(jobSummary),
    })
    .optional(),
  timestamp: count,
}) satisfies z.ZodType<QueueDetailResponse>;

/** One job of `GET /queues/:q/jobs/list`. */
export const jobListItemSchema = z
  .object({
    id: z.string(),
    name: optionalText,
    queue: optionalText,
    state: optionalText,
    status: optionalText,
    priority: optionalCount,
    data: z.unknown().optional(),
    returnvalue: z.unknown().optional(),
    result: z.unknown().optional(),
    attempts: optionalCount,
    maxAttempts: optionalCount,
    progress: optionalCount,
    createdAt: optionalCount,
    runAt: optionalCount,
    startedAt: nullableCount,
    completedAt: nullableCount,
    processedOn: optionalCount,
    finishedOn: optionalCount,
    failedReason: optionalText,
    stacktrace: textList,
  })
  .catchall(z.unknown()) satisfies z.ZodType<Job>;

/** One job of `GET /jobs/:id` and `GET /jobs/custom/:id`. */
export const jobFullSchema = z
  .object({
    id: z.string(),
    queue: optionalText,
    name: optionalText,
    data: z.unknown().optional(),
    returnvalue: z.unknown().optional(),
    failedReason: optionalText,
    result: z.unknown().optional(),
    priority: optionalCount,
    createdAt: optionalCount,
    runAt: optionalCount,
    startedAt: nullableCount,
    completedAt: nullableCount,
    attempts: optionalCount,
    maxAttempts: optionalCount,
    backoff: optionalCount,
    backoffConfig: z
      .object({
        type: z.enum(['fixed', 'exponential']),
        delay: count,
        maxDelay: optionalCount,
      })
      .nullable()
      .optional(),
    timeout: nullableCount,
    ttl: nullableCount,
    progress: optionalCount,
    progressMessage: nullableText,
    stacktrace: z.array(z.string()).nullable().optional(),
    customId: nullableText,
    parentId: nullableText,
    childrenIds: textList,
    dependsOn: textList,
    tags: textList,
    groupId: nullableText,
    removeOnComplete: z.boolean().optional(),
    removeOnFail: z.boolean().optional(),
    lastHeartbeat: optionalCount,
    stallCount: optionalCount,
    state: optionalText,
    timeline: z
      .array(
        z.object({
          state: z.string(),
          timestamp: count,
          worker: optionalText,
          error: optionalText,
          attempt: optionalCount,
        })
      )
      .optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<JobFull>;
