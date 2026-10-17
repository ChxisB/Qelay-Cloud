import type { JobState, StateCounts } from '@qelay-cloud/core';
import type {
  AttemptRecord,
  JobDetails,
  JobFailure,
  QueueSummary,
} from '@qelay-cloud/store-postgres';
import type { Wire } from './payload';
import { toWire } from './payload';

/**
 * The store's reads as the panel reads them. Field names follow `JobFull`, `QueueCountsFull` and
 * `QueueSummaryFull` of `../qelay-control-panel/src/lib/bqTypes.ts`; the fields the panel does not
 * know (`version`, `lease`, `lifo`, `truncated`, ...) are additions it ignores. A job's `version` is
 * what an operator action sends back as `expectedVersion`.
 */

export interface TimelineEntry {
  readonly state: string;
  readonly timestamp: number;
  readonly error?: string;
  readonly attempt?: number;
}

export interface JobWire {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly data: Wire;
  readonly returnvalue?: Wire;
  readonly result?: Wire;
  readonly failedReason?: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly runAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly backoff: number;
  readonly backoffConfig: {
    readonly type: 'fixed' | 'exponential';
    readonly delay: number;
    readonly maxDelay?: number;
  } | null;
  readonly timeout: number | null;
  readonly ttl: null;
  readonly progress: number;
  readonly progressMessage: string | null;
  readonly stacktrace?: string[] | null;
  readonly customId: string | null;
  /** The parent of a flow job, or null: a job without a parent, or whose parent is gone. */
  readonly parentId: string | null;
  /** The jobs that name this one as their parent; filled on a job's own page only (see `children`). */
  readonly childrenIds: string[];
  /** Always empty: a parent's children are `childrenIds`, and `GET /flows/:id` shows what holds it. */
  readonly dependsOn: string[];
  /** The root of the flow the job belongs to, or null for a job that is in none. */
  readonly flowRoot: string | null;
  readonly tags: string[];
  readonly groupId: string | null;
  readonly removeOnComplete: boolean;
  readonly removeOnFail: boolean;
  readonly stallCount?: number;
  readonly state: JobState;
  readonly timeline?: TimelineEntry[];
  /** The row's version: send it back as `expectedVersion` to fence an action to what was read. */
  readonly version: number;
  readonly lease: { readonly owner: string; readonly until: number } | null;
  readonly lifo: boolean;
  readonly stallTimeout?: number;
  readonly deduplicationId: string | null;
  /** True when `data` or `returnvalue` is a `truncated` marker in place of the payload. */
  readonly truncated: boolean;
}

export interface JobWireOptions {
  /** JSON bytes a payload may take (see `toWire`). */
  readonly payloadBytes: number;
  /** The failure read of a job's own page: adds `stacktrace`, `stallCount` and the failed attempts. */
  readonly failure?: JobFailure | null;
  /** The ids of the job's children, read on a job's own page; a list leaves them out. */
  readonly children?: readonly string[];
}

/**
 * The most entries a job's timeline carries. The panel's job inspector refuses a longer one, and a job
 * keeps up to 20 failed attempts, so the oldest are left out and the creation entry is kept.
 */
export const MAX_TIMELINE = 20;

function timelineOf(job: JobDetails, failure: JobFailure | null): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ state: 'created', timestamp: job.createdAt }];
  if (job.startedAt !== null) entries.push({ state: 'active', timestamp: job.startedAt });
  for (const attempt of failure?.attempts ?? []) {
    entries.push(failedAttempt(attempt));
  }
  if (job.completedAt !== null) {
    const last = entries.at(-1);
    const repeats = job.state === 'failed' && last?.state === 'failed';
    if (!repeats) entries.push({ state: job.state, timestamp: job.completedAt });
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length <= MAX_TIMELINE) return entries;
  return [entries[0]!, ...entries.slice(1 - MAX_TIMELINE)];
}

const failedAttempt = (attempt: AttemptRecord): TimelineEntry => ({
  state: 'failed',
  timestamp: attempt.failedAt,
  error: attempt.error,
  attempt: attempt.attempt,
});

/** One job as the panel's `JobFull`. A payload over `payloadBytes` is a marker, and `truncated` says so. */
export function toJobWire(job: JobDetails, options: JobWireOptions): JobWire {
  const data = toWire(job.data, { maxBytes: options.payloadBytes });
  const returned =
    job.returnValue === null || job.returnValue === undefined
      ? null
      : toWire(job.returnValue, { maxBytes: options.payloadBytes });
  const backoff = typeof job.options.backoff === 'object' ? job.options.backoff : undefined;
  const failure = options.failure;
  const config =
    backoff === undefined || (backoff.delay === 0 && backoff.type === 'fixed')
      ? null
      : {
          type: backoff.type,
          delay: backoff.delay,
          ...(backoff.maxDelay === undefined ? {} : { maxDelay: backoff.maxDelay }),
        };
  return {
    id: job.id,
    queue: job.queue,
    name: job.name,
    data: data.value,
    ...(returned === null ? {} : { returnvalue: returned.value, result: returned.value }),
    ...(job.failedReason === null ? {} : { failedReason: job.failedReason }),
    priority: job.priority,
    createdAt: job.createdAt,
    runAt: job.runAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    backoff: backoff?.delay ?? 0,
    backoffConfig: config,
    timeout: job.options.timeout ?? null,
    ttl: null,
    progress: job.progress,
    progressMessage: job.progressMessage,
    ...(failure === undefined
      ? {}
      : {
          stacktrace: failure?.stack == null ? null : [failure.stack],
          stallCount: failure?.stalls ?? 0,
          timeline: timelineOf(job, failure),
        }),
    customId: job.options.jobId ?? null,
    parentId: job.parentId,
    childrenIds: [...(options.children ?? [])],
    dependsOn: [],
    flowRoot: job.flowRoot,
    tags: [],
    groupId: job.options.group === undefined ? null : String(job.options.group.id),
    removeOnComplete: job.options.removeOnComplete ?? false,
    removeOnFail: job.options.removeOnFail ?? false,
    state: job.state,
    version: job.version,
    lease: job.lease,
    lifo: job.options.lifo ?? false,
    ...(job.options.stallTimeout === undefined ? {} : { stallTimeout: job.options.stallTimeout }),
    deduplicationId: job.options.deduplication?.id ?? null,
    truncated: data.truncated || (returned?.truncated ?? false),
  };
}

export interface CountsWire {
  readonly waiting: number;
  readonly prioritized: number;
  readonly delayed: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly 'waiting-children': number;
  readonly paused: number;
}

/**
 * `GET /queues/:q/counts`. `paused` follows Qelay: the jobs a pause holds back, which is what a worker
 * could claim (`waiting` plus `prioritized`) while the queue is paused, and 0 otherwise. `waiting`
 * stays what is counted, so the figures of a paused queue still add up.
 */
export const toCountsWire = (counts: StateCounts, paused: boolean): CountsWire => ({
  waiting: counts.waiting,
  prioritized: counts.prioritized,
  delayed: counts.delayed,
  active: counts.active,
  completed: counts.completed,
  failed: counts.failed,
  'waiting-children': counts['waiting-children'],
  paused: paused ? counts.waiting + counts.prioritized : 0,
});

export interface QueueSummaryWire {
  readonly name: string;
  readonly paused: boolean;
  readonly counts: {
    readonly waiting: number;
    readonly prioritized: number;
    readonly active: number;
    readonly completed: number;
    readonly failed: number;
    readonly delayed: number;
  };
}

/** One entry of `GET /queues/summary`. */
export const toSummaryWire = (summary: QueueSummary): QueueSummaryWire => ({
  name: summary.queue,
  paused: summary.paused,
  counts: {
    waiting: summary.counts.waiting,
    prioritized: summary.counts.prioritized,
    active: summary.counts.active,
    completed: summary.counts.completed,
    failed: summary.counts.failed,
    delayed: summary.counts.delayed,
  },
});
