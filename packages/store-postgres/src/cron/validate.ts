import type { JobOptions, NewJob } from '@qelay-cloud/core';
import { UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import { DEFAULT_JOB_NAME, identifier, priorityColumn } from '../store/prepare';
import { expandCronShortcut, validateCronExpression } from './parser';
import type { CronEnvelope, CronSpec } from './types';
import { CRON_TEMPLATE_KEYS } from './types';

/** Longest `repeatEvery`: the same cap as a job's `delay`. */
export const MAX_REPEAT_EVERY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_INTEGER = 2_147_483_647;

/** The key spawned jobs deduplicate on, or null when overlap is allowed and no key is named. */
export function dedupKeyOf(cron: {
  readonly name: string;
  readonly uniqueKey: string | null;
  readonly preventOverlap: boolean;
}): string | null {
  return cron.uniqueKey ?? (cron.preventOverlap ? `cron:${cron.name}` : null);
}

/** The job one occurrence creates. Shared by validation (a dry run) and firing, so they cannot differ. */
export function spawnedJob(name: string, queue: string, envelope: CronEnvelope): NewJob {
  const key = dedupKeyOf({ name, ...envelope });
  const options: JobOptions = {
    ...envelope.jobOptions,
    priority: envelope.priority,
    ...(key !== null && { deduplication: { id: key, ...envelope.dedup } }),
  };
  return { queue, name: envelope.jobName, data: envelope.data, options };
}

export interface ValidCron {
  readonly name: string;
  readonly maxLimit: number | null;
  readonly immediately: boolean;
  readonly envelope: CronEnvelope;
}

function flag(name: string, value: boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new UnsupportedOptionError(name, 'must be a boolean');
  return value;
}

function timing(
  spec: CronSpec,
  now: number
): Pick<CronEnvelope, 'schedule' | 'repeatEvery' | 'timezone'> {
  const hasSchedule = spec.schedule !== undefined;
  const hasInterval = spec.repeatEvery !== undefined;
  if (hasSchedule === hasInterval) {
    throw new UnsupportedOptionError(
      'schedule',
      'exactly one of schedule and repeatEvery is required'
    );
  }
  if (hasInterval) {
    const every = spec.repeatEvery!;
    if (!Number.isSafeInteger(every) || every < 1 || every > MAX_REPEAT_EVERY_MS) {
      throw new UnsupportedOptionError(
        'repeatEvery',
        `must be an integer from 1 to ${MAX_REPEAT_EVERY_MS} milliseconds`
      );
    }
    if (spec.timezone !== undefined) {
      throw new UnsupportedOptionError(
        'timezone',
        'only applies to a schedule, not to repeatEvery'
      );
    }
    return { schedule: null, repeatEvery: every, timezone: null };
  }
  const schedule = spec.schedule!;
  if (typeof schedule !== 'string' || schedule.trim() === '') {
    throw new UnsupportedOptionError('schedule', 'must be a non-empty string');
  }
  const zone = spec.timezone === undefined ? undefined : identifier('timezone', spec.timezone);
  const problem = validateCronExpression(expandCronShortcut(schedule), now, zone);
  if (problem) throw new UnsupportedOptionError('schedule', problem);
  return { schedule: schedule.trim(), repeatEvery: null, timezone: zone ?? null };
}

function template(spec: CronSpec): CronEnvelope['jobOptions'] {
  const given = spec.jobOptions;
  if (given === undefined) return null;
  if (typeof given !== 'object' || given === null) {
    throw new UnsupportedOptionError('jobOptions', 'must be an object');
  }
  for (const key of Object.keys(given)) {
    if (!CRON_TEMPLATE_KEYS.includes(key)) {
      throw new UnsupportedOptionError(`jobOptions.${key}`, 'is not allowed in a cron template');
    }
  }
  validateJobOptions(given);
  return { ...given };
}

/**
 * Validates a cron definition and shapes it for storage. Everything is checked here, so that a
 * stored cron can always fire: the timing, the spawned job's options and its deduplication.
 * `now` is only the point the schedule must have an occurrence after. A caller then dry-runs the
 * spawned job through `prepareJobs` for what only the codec and the payload cap can say.
 */
export function validateCron(spec: CronSpec, now: number): ValidCron {
  const name = identifier('name', spec.name);
  const queue = identifier('queue', spec.queue);
  const preventOverlap = flag('preventOverlap', spec.preventOverlap, true);
  const uniqueKey = spec.uniqueKey === undefined ? null : identifier('uniqueKey', spec.uniqueKey);
  if (spec.dedup !== undefined && uniqueKey === null && !preventOverlap) {
    throw new UnsupportedOptionError('dedup', 'needs a uniqueKey, or preventOverlap on');
  }
  if (
    spec.maxLimit !== undefined &&
    (!Number.isSafeInteger(spec.maxLimit) || spec.maxLimit < 1 || spec.maxLimit > MAX_INTEGER)
  ) {
    throw new UnsupportedOptionError('maxLimit', `must be an integer from 1 to ${MAX_INTEGER}`);
  }
  const envelope: CronEnvelope = {
    v: 1,
    queue,
    jobName: spec.jobName === undefined ? DEFAULT_JOB_NAME : identifier('jobName', spec.jobName),
    data: spec.data ?? null,
    ...timing(spec, now),
    priority: priorityColumn(spec.priority ?? 0),
    uniqueKey,
    dedup: spec.dedup === undefined ? null : { ...spec.dedup },
    skipIfNoWorker: flag('skipIfNoWorker', spec.skipIfNoWorker, false),
    preventOverlap,
    jobOptions: template(spec),
  };
  // The options of the spawned job as a whole (priority, deduplication, template) take the same
  // validation an enqueue gives them.
  validateJobOptions(spawnedJob(name, queue, envelope).options);
  return {
    name,
    maxLimit: spec.maxLimit ?? null,
    immediately: flag('immediately', spec.immediately, false),
    envelope,
  };
}
