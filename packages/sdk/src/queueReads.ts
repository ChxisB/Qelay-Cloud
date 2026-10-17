import type { WorkerInfo } from '@qelay-cloud/store-postgres';
import { queueWorkers } from './config';
import type { Job } from './job';
import { QueueJobs } from './queueJobs';
import type { GetJobsOptions, JobCounts } from './read';
import { countQueued, getJobCounts, getJobs } from './read';

/**
 * Listing jobs and counting them. Pages are `start` to `end`, exclusive, 100 jobs by default and
 * 1,000 at most. `end: -1` (everything) is refused so that no call reads a whole queue.
 */
export abstract class QueueReads<T = unknown> extends QueueJobs<T> {
  getJobs<R = unknown>(opts?: GetJobsOptions): Promise<Array<Job<T, R>>> {
    return getJobs<T>(this.rt, opts) as Promise<Array<Job<T, R>>>;
  }

  getJobsAsync<R = unknown>(opts?: GetJobsOptions): Promise<Array<Job<T, R>>> {
    return this.getJobs<R>(opts);
  }

  getWaiting<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('waiting', start, end);
  }

  getWaitingAsync<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getWaiting<R>(start, end);
  }

  getPrioritized<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('prioritized', start, end);
  }

  getDelayed<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('delayed', start, end);
  }

  getDelayedAsync<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getDelayed<R>(start, end);
  }

  getActive<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('active', start, end);
  }

  getActiveAsync<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getActive<R>(start, end);
  }

  getCompleted<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('completed', start, end);
  }

  getCompletedAsync<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getCompleted<R>(start, end);
  }

  getFailed<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('failed', start, end);
  }

  getFailedAsync<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getFailed<R>(start, end);
  }

  getWaitingChildren<R = unknown>(start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.page<R>('waiting-children', start, end);
  }

  /** The counts of every state. While the queue is paused, its ready jobs are counted as `paused`. */
  getJobCounts(): Promise<JobCounts> {
    return getJobCounts(this.rt);
  }

  getJobCountsAsync(): Promise<JobCounts> {
    return this.getJobCounts();
  }

  async getWaitingCount(): Promise<number> {
    return (await this.getJobCounts()).waiting;
  }

  async getPrioritizedCount(): Promise<number> {
    return (await this.getJobCounts()).prioritized;
  }

  async getActiveCount(): Promise<number> {
    return (await this.getJobCounts()).active;
  }

  async getCompletedCount(): Promise<number> {
    return (await this.getJobCounts()).completed;
  }

  async getFailedCount(): Promise<number> {
    return (await this.getJobCounts()).failed;
  }

  async getDelayedCount(): Promise<number> {
    return (await this.getJobCounts()).delayed;
  }

  async getWaitingChildrenCount(): Promise<number> {
    return (await this.getJobCounts())['waiting-children'];
  }

  /** Jobs still to run: waiting, prioritized, delayed and those a pause holds. */
  count(): Promise<number> {
    return countQueued(this.rt);
  }

  countAsync(): Promise<number> {
    return this.count();
  }

  /** The workers registered in this namespace that take jobs of this queue. */
  getWorkers(): Promise<WorkerInfo[]> {
    return queueWorkers(this.rt);
  }

  async getWorkersCount(): Promise<number> {
    return (await this.getWorkers()).length;
  }

  private page<R>(state: string, start?: number, end?: number): Promise<Array<Job<T, R>>> {
    return this.getJobs<R>({
      state,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    });
  }
}
