import type { JobOptions } from '@qelay-cloud/core';
import type { LogLevel } from '@qelay-cloud/store-postgres';
import type { BulkJob } from './add';
import { addJob, addJobs } from './add';
import { appendLog, clearLogs, jobLogs } from './config';
import type { JobLogs } from './config';
import type { Job } from './job';
import type { JobStateName } from './jobOps';
import * as ops from './jobOps';
import type { QueueOptions } from './options';
import { getJob } from './read';
import type { Runtime } from './runtime';
import { openRuntime } from './runtime';

/**
 * Adding jobs and acting on one job by id. The methods are Qelay's, async where Qelay's embedded
 * mode was sync: every call here is a round trip to Postgres. Each `*Async` is the same method under
 * the name code written for Qelay's TCP client already calls.
 *
 * A `Queue` sees only its own queue. Job ids are unique per namespace, not per queue, so an id
 * that belongs to another queue reads as missing here and is refused by every change.
 */
export abstract class QueueJobs<T = unknown> {
  readonly name: string;
  protected readonly rt: Runtime;

  protected constructor(name: string, options: QueueOptions) {
    this.rt = openRuntime(name, options);
    this.name = name;
  }

  /**
   * Admits one job. Resolves once it is stored: ringing the doorbell happens after that and a
   * failure of it never rejects (the tick rings the job later). Resolves with the live job
   * (`duplicated: true`) when the custom id or deduplication key matches one.
   */
  add<R = unknown>(name: string, data: T, opts?: JobOptions): Promise<Job<T, R>> {
    return addJob<T, R>(this.rt, name, data, opts);
  }

  /** In one transaction. Options are all validated before anything is sent. */
  addBulk<R = unknown>(jobs: ReadonlyArray<BulkJob<T>>): Promise<Array<Job<T, R>>> {
    return addJobs<T, R>(this.rt, jobs);
  }

  /** Null when the queue has no such job. */
  getJob<R = unknown>(id: string): Promise<Job<T, R> | null> {
    return getJob<T>(this.rt, id) as Promise<Job<T, R> | null>;
  }

  /** The job registered under a custom id: the same as `getJob`, ids being the custom ids. */
  getJobByCustomId<R = unknown>(id: string): Promise<Job<T, R> | null> {
    return this.getJob<R>(id);
  }

  /** `'unknown'` when the queue has no such job. */
  getJobState(id: string): Promise<JobStateName> {
    return ops.stateOf(this.rt, id);
  }

  /** On an active job. For any other job it does nothing. */
  updateJobProgress(id: string, progress: number | object | string): Promise<void> {
    return ops.updateProgress(this.rt, id, progress);
  }

  getJobLogs(id: string, start?: number, end?: number): Promise<JobLogs> {
    return jobLogs(this.rt, id, start, end);
  }

  /** Returns how many lines the job holds. `keepLogs` trims it to its newest lines afterwards. */
  addJobLog(id: string, logRow: string, keepLogs?: number, level?: LogLevel): Promise<number> {
    return appendLog(this.rt, id, logRow, keepLogs, level);
  }

  clearJobLogs(id: string, keepLogs?: number): Promise<void> {
    return clearLogs(this.rt, id, keepLogs);
  }

  /** Throws `JobStateError` for a finished or missing job. */
  updateJobData(id: string, data: T): Promise<void> {
    return ops.updateData(this.rt, id, data);
  }

  changeJobDelay(id: string, delay: number): Promise<void> {
    return ops.changeDelay(this.rt, id, delay);
  }

  changeJobPriority(
    id: string,
    opts: { readonly priority: number; readonly lifo?: boolean }
  ): Promise<void> {
    return ops.changePriority(this.rt, id, opts);
  }

  /** Throws `JobStateError` for an active job and `FlowProtectedError` for one a flow parent waits on. */
  remove(id: string): Promise<void> {
    return ops.removeJob(this.rt, id);
  }

  removeAsync(id: string): Promise<void> {
    return this.remove(id);
  }

  /** Makes a delayed job due now. */
  promoteJob(id: string): Promise<void> {
    return ops.promoteJob(this.rt, id);
  }

  /** The task plan's names for the five methods above: each calls the Qelay-named method. */
  removeJob(id: string): Promise<void> {
    return this.remove(id);
  }

  promote(id: string): Promise<void> {
    return this.promoteJob(id);
  }

  updateData(id: string, data: T): Promise<void> {
    return this.updateJobData(id, data);
  }

  changePriority(
    id: string,
    opts: { readonly priority: number; readonly lifo?: boolean }
  ): Promise<void> {
    return this.changeJobPriority(id, opts);
  }

  changeDelay(id: string, delay: number): Promise<void> {
    return this.changeJobDelay(id, delay);
  }
}
