import type { DlqEntry } from '@qelay-cloud/core';
import type { DlqStats } from '@qelay-cloud/store-postgres';
import {
  cleanJobs,
  drainQueue,
  isQueuePaused,
  obliterateQueue,
  pauseQueue,
  promoteJobs,
  resumeQueue,
} from './admin';
import type { DlqConfig, DlqFilter, StallConfig } from './config';
import * as config from './config';
import type { Job } from './job';
import type { QueueOptions } from './options';
import { QueueReads } from './queueReads';

/**
 * The producer and admin side of one queue of a Qelay-Cloud namespace: Qelay's `Queue` over
 * Postgres, with a cloud queue as the doorbell. `docs/compat.md` lists each method of Qelay's
 * `Queue` and says whether this one has it, has it differently, or does not.
 *
 * ```ts
 * const queue = new Queue('telemetry', { databaseUrl, transport, namespace: 'prod' });
 * await queue.add('reading', { sensor: 'a1', value: 21.5 }, { attempts: 5 });
 * await queue.close();
 * ```
 *
 * The schema must be migrated first (`migrate` of `@qelay-cloud/store-postgres`): a `Queue` never
 * changes the schema, and `waitUntilReady` reports a database that was not migrated.
 */
export class Queue<T = unknown> extends QueueReads<T> {
  /** Opens nothing: the connection is made by the first call. Throws `UnsupportedOptionError` for an option this package does not support. */
  constructor(name: string, options: QueueOptions) {
    super(name, options);
  }

  /** Resolves when the database answers and holds a migrated schema; rejects with the cause otherwise. */
  async waitUntilReady(): Promise<void> {
    await this.rt.store.counts(this.name);
  }

  pause(): Promise<void> {
    return pauseQueue(this.rt);
  }

  pauseAsync(): Promise<void> {
    return this.pause();
  }

  /** Jobs are rung again by the tick, within its interval: `resume` rings nothing itself. */
  resume(): Promise<void> {
    return resumeQueue(this.rt);
  }

  resumeAsync(): Promise<void> {
    return this.resume();
  }

  isPaused(): Promise<boolean> {
    return isQueuePaused(this.rt);
  }

  isPausedAsync(): Promise<boolean> {
    return this.isPaused();
  }

  /** Deletes the waiting, prioritized and delayed jobs, in batches. Resolves with how many. */
  drain(): Promise<number> {
    return drainQueue(this.rt);
  }

  drainAsync(): Promise<number> {
    return this.drain();
  }

  /** Deletes the queue and all of it. `JobStateError` for an active job unless `force`. */
  obliterate(options?: { readonly force?: boolean }): Promise<void> {
    return obliterateQueue(this.rt, options);
  }

  obliterateAsync(options?: { readonly force?: boolean }): Promise<void> {
    return this.obliterate(options);
  }

  /**
   * Deletes jobs of a state that are at least `grace` ms old, at most `limit` of them (0: all), and
   * returns their ids. `type`: completed (default), failed, wait, prioritized or delayed.
   */
  clean(grace: number, limit: number, type?: string): Promise<string[]> {
    return cleanJobs(this.rt, grace, limit, type);
  }

  cleanAsync(grace: number, limit: number, type?: string): Promise<string[]> {
    return this.clean(grace, limit, type);
  }

  /** Makes up to `count` delayed jobs due now. Resolves with how many it promoted. */
  promoteJobs(opts: { readonly count?: number } = {}): Promise<number> {
    return promoteJobs(this.rt, opts.count);
  }

  setStallConfig(stall: Partial<StallConfig>): Promise<StallConfig> {
    return config.setStall(this.rt, stall);
  }

  setStallConfigAsync(stall: Partial<StallConfig>): Promise<StallConfig> {
    return this.setStallConfig(stall);
  }

  getStallConfig(): Promise<StallConfig> {
    return config.getStall(this.rt);
  }

  getStallConfigAsync(): Promise<StallConfig> {
    return this.getStallConfig();
  }

  setDlqConfig(dlq: Partial<DlqConfig>): Promise<DlqConfig> {
    return config.setDlq(this.rt, dlq);
  }

  setDlqConfigAsync(dlq: Partial<DlqConfig>): Promise<DlqConfig> {
    return this.setDlqConfig(dlq);
  }

  getDlqConfig(): Promise<DlqConfig> {
    return config.getDlq(this.rt);
  }

  getDlqConfigAsync(): Promise<DlqConfig> {
    return this.getDlqConfig();
  }

  /** One page of DLQ entries, oldest failure first. */
  getDlq(filter?: DlqFilter): Promise<DlqEntry[]> {
    return config.dlqEntries(this.rt, filter);
  }

  getDlqAsync(filter?: DlqFilter): Promise<DlqEntry[]> {
    return this.getDlq(filter);
  }

  /** The failed jobs behind the first `count` DLQ entries. */
  getDlqJobsAsync<R = unknown>(count?: number): Promise<Array<Job<T, R>>> {
    return config.dlqJobs<T>(this.rt, count) as Promise<Array<Job<T, R>>>;
  }

  getDlqStats(): Promise<DlqStats> {
    return config.dlqStats(this.rt);
  }

  getDlqStatsAsync(): Promise<DlqStats> {
    return this.getDlqStats();
  }

  /** Deletes every DLQ entry and its failed job. Resolves with how many. */
  purgeDlq(): Promise<number> {
    return config.purgeDlq(this.rt);
  }

  purgeDlqAsync(): Promise<number> {
    return this.purgeDlq();
  }

  removeDlqJob(id: string): Promise<boolean> {
    return config.removeDlqJob(this.rt, id);
  }

  removeDlqJobAsync(id: string): Promise<boolean> {
    return this.removeDlqJob(id);
  }

  /** At most `concurrency` jobs of the queue active at once, across every worker. */
  setGlobalConcurrency(concurrency: number): Promise<void> {
    return config.setConcurrency(this.rt, concurrency);
  }

  setGlobalConcurrencyAsync(concurrency: number): Promise<void> {
    return this.setGlobalConcurrency(concurrency);
  }

  removeGlobalConcurrency(): Promise<void> {
    return config.setConcurrency(this.rt, null);
  }

  removeGlobalConcurrencyAsync(): Promise<void> {
    return this.removeGlobalConcurrency();
  }

  getGlobalConcurrency(): Promise<number | null> {
    return config.getConcurrency(this.rt);
  }

  /** At most `max` claims in each window of `duration` ms (default 1,000), across every worker. */
  setGlobalRateLimit(max: number, duration?: number): Promise<void> {
    return config.setRateLimit(this.rt, max, duration);
  }

  setGlobalRateLimitAsync(max: number, duration?: number): Promise<void> {
    return this.setGlobalRateLimit(max, duration);
  }

  removeGlobalRateLimit(): Promise<void> {
    return config.clearRateLimit(this.rt);
  }

  removeGlobalRateLimitAsync(): Promise<void> {
    return this.removeGlobalRateLimit();
  }

  getGlobalRateLimit(): Promise<{ max: number; duration: number } | null> {
    return config.getRateLimit(this.rt);
  }

  /** The task plan's names for the global limits: each calls the Qelay-named method. */
  setConcurrency(concurrency: number): Promise<void> {
    return this.setGlobalConcurrency(concurrency);
  }

  clearConcurrency(): Promise<void> {
    return this.removeGlobalConcurrency();
  }

  setRateLimit(max: number, duration?: number): Promise<void> {
    return this.setGlobalRateLimit(max, duration);
  }

  clearRateLimit(): Promise<void> {
    return this.removeGlobalRateLimit();
  }

  /**
   * Closes the connection pool when this queue opened it (a `store` passed in stays open: it is
   * the caller's) and never the transport. Idempotent. Pending calls finish or reject.
   */
  close(options?: { readonly timeout?: number }): Promise<void> {
    return this.rt.close(options);
  }

  /** The same as `close`, for code written against Qelay's `disconnect`. */
  disconnect(): Promise<void> {
    return this.close();
  }
}
