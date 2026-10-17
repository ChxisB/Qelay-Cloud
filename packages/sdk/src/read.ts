import type { JobState } from '@qelay-cloud/core';
import { JOB_STATES, UnsupportedOptionError } from '@qelay-cloud/core';
import { MAX_PAGE_SIZE } from '@qelay-cloud/store-postgres';
import type { Job } from './job';
import { fromDetails } from './job';
import type { Runtime } from './runtime';

export interface GetJobsOptions {
  /** One state or several, read in the order given. Default: every state. */
  readonly state?: string | readonly string[];
  /** First job to return, counted over the states in order. Default 0. */
  readonly start?: number;
  /** Where to stop, exclusive, as in Qelay. Default 100. `-1` (everything) is not supported. */
  readonly end?: number;
  /** Oldest first. Not supported: jobs come in claim order, or newest first for the finished states. */
  readonly asc?: boolean;
}

/** Qelay's `getJobCounts` result. */
export interface JobCounts {
  waiting: number;
  prioritized: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  'waiting-children': number;
}

export const DEFAULT_JOBS_END = 100;

function statesOf(state: GetJobsOptions['state']): readonly JobState[] {
  if (state === undefined) return JOB_STATES;
  const names = typeof state === 'string' ? [state] : state;
  for (const name of names) {
    if (!(JOB_STATES as readonly string[]).includes(name)) {
      throw new UnsupportedOptionError(
        'state',
        `"${name}" is not a job state (${JOB_STATES.join(', ')}): paused jobs are waiting jobs of a paused queue`
      );
    }
  }
  return [...new Set(names)] as JobState[];
}

function window(options: GetJobsOptions): { start: number; count: number } {
  if (options.asc === true) {
    throw new UnsupportedOptionError(
      'asc',
      "is not supported: pages come in the store's order (docs/compat.md)"
    );
  }
  const start = options.start ?? 0;
  const end = options.end ?? DEFAULT_JOBS_END;
  if (end === -1) {
    throw new UnsupportedOptionError(
      'end',
      `-1 (all jobs) is not supported: page with start and end, at most ${MAX_PAGE_SIZE} jobs a call`
    );
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new UnsupportedOptionError('end', 'must be an integer above start, and start at least 0');
  }
  if (end - start > MAX_PAGE_SIZE) {
    throw new UnsupportedOptionError('end', `must be at most ${MAX_PAGE_SIZE} jobs after start`);
  }
  return { start, count: end - start };
}

/**
 * One page of jobs across the states, in the order of the states and each state's own order. A
 * state whose jobs all lie before `start` is skipped by its total, so a page costs one query per
 * state it touches, plus one to read the jobs in full.
 */
export async function getJobs<T = unknown>(
  rt: Runtime,
  options: GetJobsOptions = {}
): Promise<Array<Job<T>>> {
  const states = statesOf(options.state);
  const { start, count } = window(options);
  const ids: string[] = [];
  let skip = start;
  for (const state of states) {
    if (ids.length >= count) break;
    const page = await rt.store.readModels.jobsByState(rt.name, state, {
      limit: count - ids.length,
      offset: skip,
    });
    if (page.items.length > 0) {
      skip = 0;
      ids.push(...page.items.map((item) => item.id));
    } else {
      skip = Math.max(0, skip - page.total);
    }
  }
  const details = await rt.store.control.detailsMany(ids);
  return details.map((one) => fromDetails<T>(rt, one));
}

/** Null when there is no such job in this queue. */
export async function getJob<T = unknown>(rt: Runtime, id: string): Promise<Job<T> | null> {
  const details = await rt.store.control.details(id);
  return details !== null && details.queue === rt.name ? fromDetails<T>(rt, details) : null;
}

/**
 * Qelay reports the ready jobs of a paused queue as `paused` and not as `waiting` or `prioritized`;
 * so does this.
 */
export async function getJobCounts(rt: Runtime): Promise<JobCounts> {
  const [counts, config] = await Promise.all([
    rt.store.counts(rt.name),
    rt.store.queues.config(rt.name),
  ]);
  const held = config.paused;
  return {
    waiting: held ? 0 : counts.waiting,
    prioritized: held ? 0 : counts.prioritized,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
    delayed: counts.delayed,
    paused: held ? counts.waiting + counts.prioritized : 0,
    'waiting-children': counts['waiting-children'],
  };
}

/** The jobs still to run: waiting, prioritized and delayed, and those held by a pause. */
export async function countQueued(rt: Runtime): Promise<number> {
  const counts = await getJobCounts(rt);
  return counts.waiting + counts.prioritized + counts.delayed + counts.paused;
}
