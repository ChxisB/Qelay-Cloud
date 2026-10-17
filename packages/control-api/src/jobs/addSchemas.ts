import type { JobOptions } from '@qelay-cloud/core';
import { DEFAULT_JOB_NAME } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';
import { fromWire } from './payload';

/**
 * The bodies of `POST /queues/:queue/jobs` and `.../jobs/bulk`, as the panel's `AddJobBody` and
 * `BulkJobBody` (`../qelay-control-panel/src/lib/bq/types.ts`), and the mapping of each onto this
 * store's `JobOptions`. A key the body has and this store does not is an error naming it: nothing is
 * dropped silently, because a dropped `ttl` or `dependsOn` would run a job the caller did not ask for.
 */

const MAX_TEXT = 256;
const text = z.string().min(1).max(MAX_TEXT);
const count = z.number().int().min(0);

const backoff = z.union([
  count,
  z.strictObject({
    type: z.enum(['fixed', 'exponential']),
    delay: count,
    maxDelay: count.optional(),
  }),
]);

const jobFields = {
  name: text.optional(),
  data: z.unknown(),
  priority: count.optional(),
  delay: z.number().finite().optional(),
  maxAttempts: z.number().int().min(1).optional(),
  backoff: backoff.optional(),
  timeout: z.number().int().min(1).optional(),
  jobId: text.optional(),
  removeOnComplete: z.union([z.boolean(), z.number()]).optional(),
  removeOnFail: z.union([z.boolean(), z.number()]).optional(),
  durable: z.boolean().optional(),
  ttl: z.number().optional(),
  uniqueKey: text.optional(),
  lifo: z.boolean().optional(),
  tags: z.array(z.string()).max(64).optional(),
  groupId: text.optional(),
  groupMaxSize: z.number().int().min(1).optional(),
  dependsOn: z.array(z.string()).max(1_000).optional(),
  repeat: z.unknown().optional(),
};

const dedup = z.strictObject({
  ttl: z.number().int().min(1).optional(),
  extend: z.boolean().optional(),
  replace: z.boolean().optional(),
});

/** What the panel's single add sends. */
export const addJobBody = z.strictObject(jobFields);

/** One job of a bulk add: the same, with `customId` for `jobId` and the options only bulk sends. */
export const bulkJobBody = z.strictObject({
  ...jobFields,
  customId: text.optional(),
  stallTimeout: z.number().int().min(1).optional(),
  dedup: dedup.optional(),
  stackTraceLimit: z.number().int().optional(),
  timestamp: z.number().optional(),
});

export type AddJobBody = z.infer<typeof addJobBody>;
export type BulkJobBody = z.infer<typeof bulkJobBody>;

/** `{ jobs: [...] }` of at most `maxJobs`. */
export const bulkRequest = (maxJobs: number) =>
  z.strictObject({ jobs: z.array(bulkJobBody).min(1).max(maxJobs) });

export interface NewJobInput {
  readonly name: string;
  readonly data: unknown;
  readonly opts: JobOptions;
}

const unsupported = (option: string, why: string): ApiError =>
  new ApiError(400, 'unsupported_option', `${option} ${why}`, { option });

/** Throws for what the store does not have, naming the option, and returns the job to add. */
export function toNewJob(body: AddJobBody | BulkJobBody): NewJobInput {
  const bulk = body as Partial<BulkJobBody>;
  if (body.data === undefined) throw ApiError.invalid('data is required (null is a value)');
  if (body.ttl !== undefined) {
    throw unsupported('ttl', 'is not supported: a job has no expiry of its own');
  }
  if (body.repeat !== undefined && body.repeat !== null) {
    throw unsupported('repeat', 'is not supported on a job: use a cron (POST /crons)');
  }
  if (body.dependsOn !== undefined && body.dependsOn.length > 0) {
    throw unsupported('dependsOn', 'is not supported until flows are served');
  }
  if (body.tags !== undefined && body.tags.length > 0) {
    throw unsupported('tags', 'is not supported: a job has no tags');
  }
  if (body.durable === false) {
    throw unsupported('durable', 'cannot be false: every job is stored in Postgres');
  }
  if (bulk.stackTraceLimit !== undefined || bulk.timestamp !== undefined) {
    throw unsupported(
      bulk.stackTraceLimit === undefined ? 'timestamp' : 'stackTraceLimit',
      'is not supported'
    );
  }
  if (typeof body.removeOnComplete === 'number') {
    throw unsupported(
      'removeOnComplete',
      'must be a boolean: age and count retention is unsupported'
    );
  }
  if (typeof body.removeOnFail === 'number') {
    throw unsupported('removeOnFail', 'must be a boolean: age and count retention is unsupported');
  }
  if (body.groupMaxSize !== undefined && body.groupId === undefined) {
    throw ApiError.invalid('groupMaxSize requires groupId');
  }
  if (bulk.customId !== undefined && body.jobId !== undefined && bulk.customId !== body.jobId) {
    throw ApiError.invalid('customId and jobId name the same thing: give one');
  }
  if (bulk.dedup !== undefined && body.uniqueKey === undefined) {
    throw ApiError.invalid('dedup needs uniqueKey, the key it applies to');
  }
  const jobId = bulk.customId ?? body.jobId;
  const dedupOptions = bulk.dedup ?? {};
  const opts: JobOptions = {
    ...(body.priority === undefined ? {} : { priority: body.priority }),
    ...(body.lifo === undefined ? {} : { lifo: body.lifo }),
    ...(body.delay === undefined ? {} : { delay: body.delay }),
    ...(body.maxAttempts === undefined ? {} : { attempts: body.maxAttempts }),
    ...(body.backoff === undefined ? {} : { backoff: body.backoff }),
    ...(body.timeout === undefined ? {} : { timeout: body.timeout }),
    ...(bulk.stallTimeout === undefined ? {} : { stallTimeout: bulk.stallTimeout }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(body.uniqueKey === undefined
      ? {}
      : { deduplication: { id: body.uniqueKey, ...dedupOptions } }),
    ...(body.groupId === undefined
      ? {}
      : {
          group: {
            id: body.groupId,
            ...(body.groupMaxSize === undefined ? {} : { maxSize: body.groupMaxSize }),
          },
        }),
    ...(body.removeOnComplete === undefined
      ? {}
      : { removeOnComplete: body.removeOnComplete === true }),
    ...(body.removeOnFail === undefined ? {} : { removeOnFail: body.removeOnFail === true }),
  };
  return { name: body.name ?? DEFAULT_JOB_NAME, data: fromWire(body.data), opts };
}
