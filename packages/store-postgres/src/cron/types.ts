import type { JobOptions } from '@qelay-cloud/core';

/** The job options a cron applies to every job it spawns. A subset of `JobOptions`, as upstream's. */
export type CronJobTemplate = Pick<
  JobOptions,
  | 'attempts'
  | 'backoff'
  | 'timeout'
  | 'delay'
  | 'stallTimeout'
  | 'removeOnComplete'
  | 'removeOnFail'
>;

export const CRON_TEMPLATE_KEYS: readonly string[] = [
  'attempts',
  'backoff',
  'timeout',
  'delay',
  'stallTimeout',
  'removeOnComplete',
  'removeOnFail',
];

/** How a spawned job deduplicates against a live job with the same key. */
export interface CronDedup {
  readonly ttl?: number;
  readonly extend?: boolean;
  readonly replace?: boolean;
}

/**
 * A recurring job. Exactly one of `schedule` (a 5-field cron expression, or 6 with leading
 * seconds, or a `@daily`-style shortcut) and `repeatEvery` (milliseconds) says when it fires.
 */
export interface CronSpec {
  /** Identifies the cron within the namespace; upserting the same name replaces its definition. */
  readonly name: string;
  readonly queue: string;
  /** The `name` of each job the cron creates. Default `default`. */
  readonly jobName?: string;
  readonly data?: unknown;
  readonly schedule?: string;
  readonly repeatEvery?: number;
  /** IANA time zone of `schedule`. Default UTC. Not allowed with `repeatEvery`. */
  readonly timezone?: string;
  readonly priority?: number;
  /** Stop after this many executions. Omit for no limit. */
  readonly maxLimit?: number;
  /** Deduplication key of the jobs it creates. Default `cron:<name>` when `preventOverlap` is on. */
  readonly uniqueKey?: string;
  /** Needs a key: `uniqueKey`, or `preventOverlap`. */
  readonly dedup?: CronDedup;
  /** Skip an occurrence, uncounted, while no worker is registered for the queue. Default false. */
  readonly skipIfNoWorker?: boolean;
  /** Skip an occurrence, uncounted, while the previous job of this cron is still live. Default true. */
  readonly preventOverlap?: boolean;
  /** Fire as soon as the cron is first created, then follow the schedule. Default false. */
  readonly immediately?: boolean;
  readonly jobOptions?: CronJobTemplate;
}

export interface CronRecord {
  readonly name: string;
  readonly queue: string;
  readonly jobName: string;
  readonly data: unknown;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly timezone: string | null;
  readonly priority: number;
  readonly maxLimit: number | null;
  readonly uniqueKey: string | null;
  readonly dedup: CronDedup | null;
  readonly skipIfNoWorker: boolean;
  readonly preventOverlap: boolean;
  readonly jobOptions: CronJobTemplate | null;
  /** When the cron is next due, in milliseconds. A cron at its `maxLimit` is never due. */
  readonly nextRun: number;
  readonly executions: number;
  readonly updatedAt: number;
}

/** What the payload column holds: the definition, without what the columns carry. */
export interface CronEnvelope {
  readonly v: 1;
  readonly queue: string;
  readonly jobName: string;
  readonly data: unknown;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly timezone: string | null;
  readonly priority: number;
  readonly uniqueKey: string | null;
  readonly dedup: CronDedup | null;
  readonly skipIfNoWorker: boolean;
  readonly preventOverlap: boolean;
  readonly jobOptions: CronJobTemplate | null;
}
