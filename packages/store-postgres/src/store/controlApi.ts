import type { OperatorOptions, Outcome } from '@qelay-cloud/core';
import type { CleanReport } from './clean';
import type { StoreContext } from './context';
import type { JobDetails } from './jobDetails';
import { jobDetails, jobsDetails } from './jobDetails';
import { changeJobDelay, updateJobData, updateJobProgress } from './jobEdits';
import type { JobFailure } from './jobFailure';
import { jobFailure, jobFailures } from './jobFailure';
import type { PendingCleanOptions } from './pendingClean';
import { cleanPending, drainQueue } from './pendingClean';
import type { ObliterateOptions, ObliterateReport, RemoveResult } from './queueControl';
import { obliterateQueue, removeJob } from './queueControl';

/**
 * What the SDK's `Queue` and `Job` need beyond the rest of the store: one job read in full, edits of a
 * job that is not finished, and the deletions. Everything here is a decision about one job or one
 * queue taken in one transaction; none of it is part of the claim path.
 */
export interface ControlApi {
  /** One job with its progress, result, failure, timestamps and options; null if it does not exist. */
  details(id: string): Promise<JobDetails | null>;
  /** `details` of up to 1,000 jobs in one query, in the order of `ids`; an unknown id is left out. */
  detailsMany(ids: readonly string[]): Promise<JobDetails[]>;
  /** How a job failed, for its own page: the final reason and stack and the attempts before. Null if none. */
  failure(id: string): Promise<JobFailure | null>;
  /** `failure` of up to 1,000 jobs in one query. A job with no failure has no key. */
  failuresMany(ids: readonly string[]): Promise<Map<string, JobFailure>>;
  /**
   * Replaces the data of a job that is not finished. False for a finished job or an unknown id. This
   * and every other edit here takes `expectedVersion` and throws `JobVersionError` when the job moved on.
   */
  updateData(id: string, data: unknown, options?: OperatorOptions): Promise<boolean>;
  /** Moves a delayed job to now plus `delayMs`. `ok: false` for any other job. */
  changeDelay(id: string, delayMs: number, options?: OperatorOptions): Promise<Outcome>;
  /** Stores an active job's progress (see `normalizeProgress`). False for any other job. */
  updateProgress(id: string, progress: unknown, message?: string): Promise<boolean>;
  /** Deletes one job that is not active and that no live flow parent waits on. */
  remove(id: string, options?: OperatorOptions): Promise<RemoveResult>;
  /** Deletes the waiting, prioritized and delayed jobs of a queue, a bounded batch at a time. */
  drain(queue: string, options?: { readonly limit?: number }): Promise<CleanReport>;
  /** Deletes the jobs of one pending state that are old enough, a bounded batch at a time. */
  cleanPending(queue: string, options: PendingCleanOptions): Promise<CleanReport>;
  /** Deletes a queue and everything of it, a bounded batch of jobs at a time. */
  obliterate(queue: string, options?: ObliterateOptions): Promise<ObliterateReport>;
}

export const controlApi = (ctx: StoreContext): ControlApi => ({
  details: (id) => jobDetails(ctx, id),
  detailsMany: (ids) => jobsDetails(ctx, ids),
  failure: (id) => jobFailure(ctx, id),
  failuresMany: (ids) => jobFailures(ctx, ids),
  updateData: (id, data, options) => updateJobData(ctx, id, data, options),
  changeDelay: (id, delayMs, options) => changeJobDelay(ctx, id, delayMs, options),
  updateProgress: (id, progress, message) => updateJobProgress(ctx, id, progress, message),
  remove: (id, options) => removeJob(ctx, id, options),
  drain: (queue, options) => drainQueue(ctx, queue, options),
  cleanPending: (queue, options) => cleanPending(ctx, queue, options),
  obliterate: (queue, options) => obliterateQueue(ctx, queue, options),
});
