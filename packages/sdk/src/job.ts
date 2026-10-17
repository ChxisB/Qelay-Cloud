import type { JobOptions } from '@qelay-cloud/core';
import type { JobDetails, LogLevel } from '@qelay-cloud/store-postgres';
import type { FlowReads } from './flowOps';
import { flowReads } from './flowOps';
import type { JobStateName } from './jobOps';
import * as ops from './jobOps';
import type { Runtime } from './runtime';

/**
 * A job as `Queue.add` and the reads return it: the fields Qelay's `Job` has for the supported
 * subset, and the instance methods of that subset, each running through the store. Fields are a
 * snapshot taken when the job was read; `getState()` reads again. A flow parent also reads its
 * children (`getChildrenValues`, `getDependencies`, `getFailedChildrenValues`,
 * `getIgnoredChildrenFailures`). What is not here (`retry`, `extendLock`, `token`, `parent`,
 * `stacktrace`, `repeatJobKey`) is listed in `docs/compat.md`.
 */
export interface Job<T = unknown, R = unknown> extends FlowReads {
  readonly id: string;
  readonly name: string;
  readonly queueName: string;
  /** Replaced by a successful `updateData`. */
  data: T;
  /** The options the job was added with. A job read back shows them as stored; `delay` is spent, see `docs/compat.md`. */
  readonly opts: JobOptions;
  /** Epoch milliseconds the job was created: the client clock for a job `add` returned, the database clock for one read. */
  readonly timestamp: number;
  readonly priority: number;
  readonly attemptsMade: number;
  /** 0 to 100. */
  readonly progress: number;
  readonly returnvalue: R | undefined;
  readonly failedReason: string | undefined;
  readonly processedOn: number | undefined;
  readonly finishedOn: number | undefined;
  /** True when a live job with the same custom id or deduplication key was returned instead of a new one. */
  readonly duplicated: boolean;
  /** Stores progress on an active job; on a job in any other state it does nothing. */
  updateProgress(progress: number | object | string, message?: string): Promise<void>;
  log(message: string, level?: LogLevel): Promise<void>;
  getState(): Promise<JobStateName>;
  isWaiting(): Promise<boolean>;
  isActive(): Promise<boolean>;
  isDelayed(): Promise<boolean>;
  isCompleted(): Promise<boolean>;
  isFailed(): Promise<boolean>;
  isWaitingChildren(): Promise<boolean>;
  /** Throws `JobStateError` for a finished or missing job. */
  updateData(data: T): Promise<void>;
  /** Throws `JobStateError` for an active job and `FlowProtectedError` for one a flow parent waits on. */
  remove(): Promise<void>;
  /** Makes a delayed job due now. */
  promote(): Promise<void>;
  /** For a delayed job. */
  changeDelay(delay: number): Promise<void>;
  changePriority(options: { readonly priority: number; readonly lifo?: boolean }): Promise<void>;
}

export interface JobFields<T, R> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly opts: JobOptions;
  readonly timestamp: number;
  readonly priority: number;
  readonly attemptsMade: number;
  readonly progress: number;
  readonly returnvalue?: R;
  readonly failedReason?: string;
  readonly processedOn?: number;
  readonly finishedOn?: number;
  readonly duplicated: boolean;
}

export function createJob<T, R>(rt: Runtime, fields: JobFields<T, R>): Job<T, R> {
  const { id } = fields;
  const is = (state: JobStateName) => async () => (await ops.stateOf(rt, id)) === state;
  const job: Job<T, R> = {
    ...fields,
    queueName: rt.name,
    returnvalue: fields.returnvalue,
    failedReason: fields.failedReason,
    processedOn: fields.processedOn,
    finishedOn: fields.finishedOn,
    updateProgress: (progress, message) => ops.updateProgress(rt, id, progress, message),
    log: async (message, level) => {
      await ops.addLog(rt, id, message, level);
    },
    getState: () => ops.stateOf(rt, id),
    isWaiting: is('waiting'),
    isActive: is('active'),
    isDelayed: is('delayed'),
    isCompleted: is('completed'),
    isFailed: is('failed'),
    isWaitingChildren: is('waiting-children'),
    updateData: async (data) => {
      await ops.updateData(rt, id, data);
      job.data = data;
    },
    remove: () => ops.removeJob(rt, id),
    promote: () => ops.promoteJob(rt, id),
    changeDelay: (delay) => ops.changeDelay(rt, id, delay),
    changePriority: (options) => ops.changePriority(rt, id, options),
    ...flowReads(rt, id),
  };
  return job;
}

/** A job read from the store in full. */
export function fromDetails<T = unknown, R = unknown>(
  rt: Runtime,
  details: JobDetails,
  duplicated = false
): Job<T, R> {
  return createJob<T, R>(rt, {
    id: details.id,
    name: details.name,
    data: details.data as T,
    opts: details.options,
    timestamp: details.createdAt,
    priority: details.priority,
    attemptsMade: details.attempts,
    progress: details.progress,
    ...(details.returnValue === null ? {} : { returnvalue: details.returnValue as R }),
    ...(details.failedReason === null ? {} : { failedReason: details.failedReason }),
    ...(details.startedAt === null ? {} : { processedOn: details.startedAt }),
    ...(details.completedAt === null ? {} : { finishedOn: details.completedAt }),
    duplicated,
  });
}
