import type { QueueRunWindowInput } from '@qelay-cloud/core';
import { MAX_DLQ_RETRY } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';

/**
 * The bodies of the operator actions. Every object is strict: a misspelt `expectedVersion` would
 * otherwise be dropped and the action would run unfenced, which is the failure the fence is for.
 * An action with no body at all is a valid call (the panel sends none for pause or promote), so the
 * schemas of those are `.optional()`.
 */

/** The `version` the caller read: the action is refused (409) when the job has moved on since. */
const expectedVersion = z.number().int().min(0).optional();

const count = z.number().int().min(0);
const positive = z.number().int().min(1);

/** Actions on one job that take no input but the fence. */
export const fencedBody = z.strictObject({ expectedVersion }).optional();

export const jobDataBody = z
  .strictObject({ data: z.unknown(), expectedVersion })
  .refine((body) => body.data !== undefined, { message: 'data is required (null is a value)' });

export const jobPriorityBody = z.strictObject({
  priority: count,
  /** Accepted only when it equals the job's own: a job's order within its priority is fixed at add. */
  lifo: z.boolean().optional(),
  expectedVersion,
});

export const jobDelayBody = z.strictObject({
  delay: z.number().finite().min(0),
  expectedVersion,
});

export const jobProgressBody = z.strictObject({
  progress: z.union([z.number(), z.string(), z.record(z.string(), z.unknown())]),
  message: z.string().max(4_096).optional(),
});

export const jobLogBody = z.strictObject({
  message: z.string().min(1).max(16_384),
  level: z.enum(['info', 'warn', 'error']).optional(),
});

/** `DELETE` carries no body, so the fence of a removal is a query parameter. */
export const fencedQuery = z.object({ expectedVersion: z.coerce.number().int().min(0).optional() });

export const rateLimitBody = z.strictObject({
  /** Jobs per window. */
  limit: positive,
  /** Window length, ms. Default 1,000. */
  duration: positive.optional(),
  /** The limit lifts itself after this many ms. */
  ttl: positive.optional(),
});

export const concurrencyBody = z.strictObject({ concurrency: positive });

export const promoteJobsBody = z.strictObject({ count: positive.max(1_000).optional() }).optional();

/** The states a clean takes. `wait` is Qelay's name for `waiting`. */
export const CLEAN_STATES = [
  'completed',
  'failed',
  'wait',
  'waiting',
  'prioritized',
  'delayed',
] as const;

/**
 * Drain, clean and obliterate delete jobs and cannot be undone, so each takes the queue's name as
 * `confirm`: a stray POST, or an action aimed at the wrong queue, is refused before anything is read.
 */
export const drainBody = z.strictObject({ confirm: z.string().optional() }).optional();

export const cleanBody = z
  .strictObject({
    confirm: z.string().optional(),
    /** Only jobs at least this old, ms (finished that long ago; created that long ago for pending states). */
    grace: count.optional(),
    state: z.enum(CLEAN_STATES).optional(),
    /** At most this many. Absent or 0: every eligible job (within the call's time budget). */
    limit: count.optional(),
  })
  .optional();

export const obliterateBody = z
  .strictObject({
    confirm: z.string().optional(),
    /** Delete active jobs too. Their workers' next heartbeat or finish finds no job. */
    force: z.boolean().optional(),
  })
  .optional();

/** Purging a DLQ deletes its jobs for good, so it takes the queue's name like drain does. */
export const purgeDlqBody = z.strictObject({ confirm: z.string().optional() }).optional();

/** `POST /queues/:queue/dlq/retry`: up to `limit` (default and most 500) entries, oldest failure first, optionally one `reason`. */
export const retryDlqBody = z
  .strictObject({
    confirm: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_DLQ_RETRY).optional(),
    reason: z.enum(['explicit_fail', 'max_attempts_exceeded', 'timeout', 'stalled']).optional(),
  })
  .optional();

/** The panel sends `{ config }`; Qelay also takes the settings bare, so both are accepted. */
const unwrapConfig = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'config' in value
    ? (value as { config: unknown }).config
    : value;

/**
 * `PUT /queues/:queue/stall-config`. Only `maxStalls` is a setting of this service. The other three
 * are how a lease works (`enabled` is always true, `stallInterval` is the lease length, `gracePeriod`
 * is 0), so a save that sends them back unchanged is accepted and one that changes them is a 400.
 */
export const stallConfigBody = z.preprocess(
  unwrapConfig,
  z.strictObject({
    enabled: z.boolean().optional(),
    stallInterval: z.number().finite().optional(),
    maxStalls: count.optional(),
    gracePeriod: z.number().finite().optional(),
  })
);

/**
 * `PUT /queues/:queue/dlq-config`. Retention (`maxAge`, `maxEntries`) is saved; the route checks the values.
 * Auto-retry stays closed: a value equal to the current one is a no-op, `autoRetry: true` is 501.
 */
export const dlqConfigBody = z.preprocess(
  unwrapConfig,
  z.strictObject({
    autoRetry: z.boolean().optional(),
    autoRetryInterval: z.number().finite().optional(),
    maxAutoRetries: z.number().finite().optional(),
    maxAge: z.number().finite().nullable().optional(),
    maxEntries: z.number().int().optional(),
  })
);

/**
 * `PUT /queues/:queue/policy`. Any object: the store checks it with the rules of the job options and refuses a
 * setting it does not have by name (400 `unsupported_option`), so the message names the field. `{}` removes the policy.
 */
export const queuePolicyBody = z.record(z.string(), z.unknown());

/**
 * `PUT /queues/:queue/run-window`. Any plain object: the store checks the fields and names the one it refuses (400
 * `unsupported_option`), so the type here is only the shape the store takes.
 */
export const runWindowBody = z.custom<QueueRunWindowInput>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'must be an object with cron, durationMs and optional timezone'
);

/** 400 `confirmation_required` unless `confirm` is exactly the queue's name. */
export function requireConfirmation(
  queue: string,
  confirm: string | undefined,
  action: string,
  effect = 'deletes jobs for good'
): void {
  if (confirm === queue) return;
  throw new ApiError(
    400,
    'confirmation_required',
    `${action} ${effect}: send "confirm" with the queue's name to proceed`,
    { required: 'confirm', equals: 'the queue name' }
  );
}
