import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { LogLevel } from '@qelay-cloud/store-postgres';
import type { FlowReads } from './flowOps';
import type { QueueOptions } from './options';
import { rejectLegacyOptions } from './options';

/**
 * Throw it from a processor to fail the job for good, whatever attempts are left. Qelay's class of
 * the same name; `job.discard()` does the same without throwing.
 */
export class UnrecoverableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/** What a processor receives: the claimed job and the calls that report on it while it runs. */
export interface WorkerJob<T = unknown> extends FlowReads {
  readonly id: string;
  readonly name: string;
  readonly queueName: string;
  readonly data: T;
  /** Attempts that failed or stalled before this one. 0 on the first try. */
  readonly attemptsMade: number;
  /**
   * Stores progress and emits `progress`. Best effort: a store failure is logged and counted, never
   * thrown into the processor, and once the lease is lost or the worker is closing it does nothing.
   */
  updateProgress(progress: number | object | string, message?: string): Promise<void>;
  /** Adds a log line to the job. Best effort, like `updateProgress`. */
  log(message: string, level?: LogLevel): Promise<void>;
  /** The job fails for good if this attempt fails: no retry, straight to the DLQ. */
  discard(): void;
  isDiscarded(): boolean;
}

/** What a processor receives after its job, as in Qelay's `ProcessorContext`. */
export interface ProcessorContext {
  /**
   * Aborts when the lease is lost or cannot be confirmed, and when `close` runs out of grace; stop
   * work when it does. A processor that ignores it keeps its slot until it returns, and its result
   * is dropped.
   */
  readonly signal: AbortSignal;
}

export type Processor<T = unknown, R = unknown> = (
  job: WorkerJob<T>,
  context: ProcessorContext
) => Promise<R> | R;

/** What a `Worker` is built from. The connection options are a `Queue`'s, without `defaultJobOptions`. */
export interface WorkerOptions extends Omit<QueueOptions, 'defaultJobOptions'> {
  /** Jobs run at once by this worker, 1 to 10,000. Default 1. */
  readonly concurrency?: number;
  /** Start taking jobs from the constructor on. Default true; with false call `run()`. */
  readonly autorun?: boolean;
  /**
   * How long a lease lasts without a heartbeat, in ms. The worker beats at a third of it. Default
   * 30,000. With a `store` it must equal the store's `leaseMs`, which sets the length of every beat.
   */
  readonly lockDuration?: number;
  /** Milliseconds between the worker's heartbeats in `qcloud_workers`. Default 10,000; 0 turns them off. */
  readonly heartbeatInterval?: number;
  /** A display name for the worker list. Default: the worker's id. */
  readonly workerName?: string;
  /** Limits per job group, applied by the claim. `limit` is a fixed window. */
  readonly group?: {
    readonly concurrency?: number;
    readonly limit?: { readonly max: number; readonly duration: number };
  };
  /**
   * How long the worker stays idle before it checks whether the queue is empty and emits `drained`.
   * Default 250.
   */
  readonly drainedAfterMs?: number;
  /** Close the transport with the worker. Default false: the transport belongs to the caller. */
  readonly closeTransport?: boolean;
}

export interface ResolvedWorkerOptions {
  readonly concurrency: number;
  readonly autorun: boolean;
  readonly lockDuration: number | undefined;
  readonly heartbeatInterval: number;
  readonly workerName: string | undefined;
  readonly group: WorkerOptions['group'];
  readonly drainedAfterMs: number;
  readonly closeTransport: boolean;
}

export const MAX_WORKER_CONCURRENCY = 10_000;
export const MIN_LOCK_DURATION_MS = 50;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_DRAINED_AFTER_MS = 250;

const REFUSED: Readonly<Record<string, string>> = {
  batchSize: 'a bell claims as many jobs as the free slots allow',
  pollTimeout: 'the worker waits for bells and does not poll',
  drainDelay: 'the worker waits for bells and does not poll; see drainedAfterMs for `drained`',
  useLocks: 'a job is always leased and heartbeated',
  skipLockRenewal: 'a job is always leased and heartbeated',
  skipStalledCheck: 'recovery is the tick’s; the stall limit is per queue: queue.setStallConfig',
  maxStalledCount: 'the stall limit is per queue: queue.setStallConfig({ maxStalls })',
  limiter: 'a rate limit is the queue’s and holds across workers: queue.setGlobalRateLimit',
  batch: 'batch processing is not supported',
  removeOnComplete: 'give it to the job: JobOptions.removeOnComplete',
  removeOnFail: 'give it to the job: JobOptions.removeOnFail',
};

function integer(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new UnsupportedOptionError(name, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Validates the options before anything opens; an unsupported Qelay option throws here, by name. */
export function resolveWorkerOptions(options: WorkerOptions): ResolvedWorkerOptions {
  rejectLegacyOptions(options);
  for (const key of Object.keys(options)) {
    const advice = REFUSED[key];
    if (advice !== undefined) {
      throw new UnsupportedOptionError(
        key,
        `is a Qelay option and is not supported: ${advice} (docs/compat.md)`
      );
    }
  }
  if (
    options.workerName !== undefined &&
    (typeof options.workerName !== 'string' || options.workerName === '')
  ) {
    throw new UnsupportedOptionError('workerName', 'must be a non-empty string');
  }
  const { group } = options;
  if (group !== undefined) {
    integer('group.concurrency', group.concurrency, 1, 1, 1_000_000);
    if (group.limit !== undefined) {
      integer('group.limit.max', group.limit.max, 1, 1, 1_000_000);
      integer('group.limit.duration', group.limit.duration, 1, 1, 86_400_000);
    }
  }
  return {
    concurrency: integer('concurrency', options.concurrency, 1, 1, MAX_WORKER_CONCURRENCY),
    autorun: options.autorun ?? true,
    lockDuration:
      options.lockDuration === undefined
        ? undefined
        : integer('lockDuration', options.lockDuration, 0, MIN_LOCK_DURATION_MS, 86_400_000),
    heartbeatInterval: integer(
      'heartbeatInterval',
      options.heartbeatInterval,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      0,
      3_600_000
    ),
    workerName: options.workerName,
    group,
    drainedAfterMs: integer(
      'drainedAfterMs',
      options.drainedAfterMs,
      DEFAULT_DRAINED_AFTER_MS,
      0,
      3_600_000
    ),
    closeTransport: options.closeTransport ?? false,
  };
}

export interface WorkerCloseOptions {
  /** How long running jobs may finish before they are aborted and released. Default 10,000; 0 aborts at once. */
  readonly graceMs?: number;
  /**
   * The budget of each of the two steps after the grace: aborting and releasing the jobs, then
   * closing the registry row, the transport and the store. `close` returns within
   * `graceMs + 2 × timeout` plus scheduling, whatever the database or broker does. Default 5,000.
   */
  readonly timeout?: number;
}

export interface WorkerEvents<T, R> {
  ready: () => void;
  closed: () => void;
  drained: () => void;
  active: (job: WorkerJob<T>) => void;
  completed: (job: WorkerJob<T>, result: R) => void;
  failed: (job: WorkerJob<T>, error: Error) => void;
  progress: (job: WorkerJob<T>, progress: number | object | string) => void;
  log: (job: WorkerJob<T>, message: string) => void;
  stalled: (jobId: string, reason: 'lease-lost' | 'lease-unconfirmed') => void;
  error: (error: Error) => void;
}
