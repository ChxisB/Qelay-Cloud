import type { CronJobTemplate, CronRecord, CronSpec } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';
import { fromWire } from './payload';

/**
 * A cron as the panel's cron page reads and writes it: `CronFull` and `CreateCronBody` of
 * `../qelay-control-panel/src/lib/bqTypes.ts` and `src/lib/bq/types.ts`, and the mapping of each onto
 * the store's `CronSpec`. The panel names a template's attempts `maxAttempts`; the store, like
 * Qelay's `JobOptions`, calls it `attempts`.
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

const jobOptions = z.strictObject({
  maxAttempts: z.number().int().min(1).optional(),
  backoff: backoff.optional(),
  timeout: z.number().int().min(1).optional(),
  delay: z.number().finite().optional(),
  stallTimeout: z.number().int().min(1).optional(),
  removeOnComplete: z.boolean().optional(),
  removeOnFail: z.boolean().optional(),
});

const dedup = z.strictObject({
  ttl: z.number().int().min(1).optional(),
  extend: z.boolean().optional(),
  replace: z.boolean().optional(),
});

/**
 * `POST /crons` and `PUT /crons/:name`. Unknown keys are errors naming them, and so are the values
 * the store checks (a bad expression, an unknown zone, both timings), through its own validation.
 * Which of `schedule` and `repeatEvery` is present is the store's rule too, so its message is the
 * one a caller sees.
 */
export const cronBody = z.strictObject({
  name: text.optional(),
  queue: text,
  jobName: text.optional(),
  data: z.unknown().optional(),
  schedule: z.string().max(MAX_TEXT).optional(),
  repeatEvery: z.number().optional(),
  priority: count.optional(),
  timezone: text.optional(),
  skipIfNoWorker: z.boolean().optional(),
  preventOverlap: z.boolean().optional(),
  maxLimit: z.number().optional(),
  immediately: z.boolean().optional(),
  skipMissedOnRestart: z.boolean().optional(),
  uniqueKey: text.optional(),
  dedup: dedup.optional(),
  jobOptions: jobOptions.optional(),
});

export type CronBody = z.infer<typeof cronBody>;

function template(given: NonNullable<CronBody['jobOptions']>): CronJobTemplate {
  return {
    ...(given.maxAttempts === undefined ? {} : { attempts: given.maxAttempts }),
    ...(given.backoff === undefined ? {} : { backoff: given.backoff }),
    ...(given.timeout === undefined ? {} : { timeout: given.timeout }),
    ...(given.delay === undefined ? {} : { delay: given.delay }),
    ...(given.stallTimeout === undefined ? {} : { stallTimeout: given.stallTimeout }),
    ...(given.removeOnComplete === undefined ? {} : { removeOnComplete: given.removeOnComplete }),
    ...(given.removeOnFail === undefined ? {} : { removeOnFail: given.removeOnFail }),
  };
}

/** The spec to upsert. `name` is the path's when the route has one; a body that names another is 400. */
export function toCronSpec(body: CronBody, pathName?: string): CronSpec {
  if (pathName !== undefined && body.name !== undefined && body.name !== pathName) {
    throw ApiError.invalid('name in the body is not the name in the path', {
      path: pathName,
      body: body.name,
    });
  }
  const name = pathName ?? body.name;
  if (name === undefined) throw ApiError.invalid('name is required');
  if (body.skipMissedOnRestart === false) {
    throw new ApiError(
      400,
      'unsupported_option',
      'skipMissedOnRestart cannot be false: a missed occurrence is never made up',
      { option: 'skipMissedOnRestart' }
    );
  }
  return {
    name,
    queue: body.queue,
    ...(body.jobName === undefined ? {} : { jobName: body.jobName }),
    ...(body.data === undefined ? {} : { data: fromWire(body.data) }),
    ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
    ...(body.repeatEvery === undefined ? {} : { repeatEvery: body.repeatEvery }),
    ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    ...(body.priority === undefined ? {} : { priority: body.priority }),
    ...(body.maxLimit === undefined ? {} : { maxLimit: body.maxLimit }),
    ...(body.uniqueKey === undefined ? {} : { uniqueKey: body.uniqueKey }),
    ...(body.dedup === undefined ? {} : { dedup: body.dedup }),
    ...(body.skipIfNoWorker === undefined ? {} : { skipIfNoWorker: body.skipIfNoWorker }),
    ...(body.preventOverlap === undefined ? {} : { preventOverlap: body.preventOverlap }),
    ...(body.immediately === undefined ? {} : { immediately: body.immediately }),
    ...(body.jobOptions === undefined ? {} : { jobOptions: template(body.jobOptions) }),
  };
}

export interface CronWire {
  readonly name: string;
  readonly jobName: string;
  readonly queue: string;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  /** When the cron is next due. A cron at its `maxLimit` is never due again; see `exhausted`. */
  readonly nextRun: number;
  readonly executions: number;
  readonly maxLimit: number | null;
  /** True once `executions` reached `maxLimit`: nothing fires any more and `nextRun` is stale. */
  readonly exhausted: boolean;
  readonly timezone: string | null;
  readonly priority: number;
  readonly uniqueKey: string | null;
  readonly dedup: { ttl?: number; extend?: boolean; replace?: boolean } | null;
  /** Always true: an occurrence that was missed is skipped, not made up. */
  readonly skipMissedOnRestart: true;
  readonly skipIfNoWorker: boolean;
  readonly preventOverlap: boolean;
  readonly jobOptions: {
    maxAttempts?: number;
    backoff?: number | { type: 'fixed' | 'exponential'; delay: number; maxDelay?: number };
    timeout?: number;
    delay?: number;
    stallTimeout?: number;
    removeOnComplete?: boolean;
    removeOnFail?: boolean;
  } | null;
  readonly updatedAt: number;
}

const jobOptionsWire = (given: CronJobTemplate | null): CronWire['jobOptions'] => {
  if (given === null) return null;
  const { attempts, ...rest } = given;
  return { ...(attempts === undefined ? {} : { maxAttempts: attempts }), ...rest };
};

/** The cron without its `data`, which can be as large as a job's payload and is not on the page. */
export const toCronWire = (cron: CronRecord): CronWire => ({
  name: cron.name,
  jobName: cron.jobName,
  queue: cron.queue,
  schedule: cron.schedule,
  repeatEvery: cron.repeatEvery,
  nextRun: cron.nextRun,
  executions: cron.executions,
  maxLimit: cron.maxLimit,
  exhausted: cron.maxLimit !== null && cron.executions >= cron.maxLimit,
  timezone: cron.timezone,
  priority: cron.priority,
  uniqueKey: cron.uniqueKey,
  dedup: cron.dedup === null ? null : { ...cron.dedup },
  skipMissedOnRestart: true,
  skipIfNoWorker: cron.skipIfNoWorker,
  preventOverlap: cron.preventOverlap,
  jobOptions: jobOptionsWire(cron.jobOptions),
  updatedAt: cron.updatedAt,
});
