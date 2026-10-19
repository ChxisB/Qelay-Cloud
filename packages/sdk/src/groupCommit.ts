import type { JobOptions, NewJob } from '@qelay-cloud/core';
import { UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import { admitEach } from './add';
import type { BulkJob } from './add';
import type { Job } from './job';
import type { Runtime } from './runtime';

/** Jobs of one group commit when the caller gives no `maxJobs`. */
export const DEFAULT_GROUP_COMMIT_JOBS = 100;
/** The store admits at most this many jobs per transaction (`MAX_BATCH`). */
const MAX_GROUP_COMMIT_JOBS = 1000;

interface Pending {
  readonly item: BulkJob<unknown>;
  readonly merged: JobOptions;
  readonly resolve: (job: Job<unknown, unknown>) => void;
  readonly reject: (error: unknown) => void;
}

export function groupCommitSize(
  option: boolean | { readonly maxJobs?: number },
  name = 'groupCommit'
): number {
  const maxJobs = typeof option === 'object' ? option.maxJobs : undefined;
  if (maxJobs === undefined) return DEFAULT_GROUP_COMMIT_JOBS;
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_GROUP_COMMIT_JOBS) {
    throw new UnsupportedOptionError(
      `${name}.maxJobs`,
      `must be an integer from 1 to ${MAX_GROUP_COMMIT_JOBS}`
    );
  }
  return maxJobs;
}

/**
 * Adds that arrive while another add is being stored share one transaction (one commit, one trip
 * through the journal's commit order, one ring call). Nothing waits on a timer: the first add
 * of an idle queue goes out in the same tick, so a caller that awaits each `add` sees no change.
 *
 * A bad option fails its own caller before it joins a batch. A batch the store refuses is checked
 * job by job, so a job the store rejects on its own input (too large, not encodable) fails alone and the
 * rest are stored; any other failure rejects the whole batch, as it would `addBulk`.
 *
 * shortcut: with `tracing` on, one producer span covers a batch and is not a child of each caller's
 * span; give it up (leave `groupCommit` off) when per-add traces matter.
 */
export class AddBatcher {
  readonly #rt: Runtime;
  readonly #maxJobs: number;
  #pending: Pending[] = [];
  #running: Promise<void> | null = null;

  constructor(rt: Runtime, maxJobs: number) {
    this.#rt = rt;
    this.#maxJobs = maxJobs;
  }

  add<T, R>(name: string, data: T, opts?: JobOptions): Promise<Job<T, R>> {
    let merged: JobOptions;
    try {
      if (typeof name !== 'string') throw new UnsupportedOptionError('name', 'must be a string');
      merged = validateJobOptions({ ...this.#rt.defaults, ...opts });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const item: BulkJob<unknown> = { name, data, ...(opts === undefined ? {} : { opts }) };
      this.#pending.push({ item, merged, resolve: resolve as Pending['resolve'], reject });
      this.#running ??= Promise.resolve().then(() => this.#run());
    });
  }

  /** Resolves once everything added so far is stored or has failed. `Queue.close` waits for it. */
  async drain(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  async #run(): Promise<void> {
    try {
      while (this.#pending.length > 0) await this.#flush(this.#pending.splice(0, this.#maxJobs));
    } finally {
      // No await since the loop test, so an add made after it cannot see a stale `#running`.
      this.#running = null;
    }
  }

  async #flush(batch: Pending[]): Promise<void> {
    const rt = this.#rt;
    rt.observe('qcloud.add.group_size', batch.length);
    try {
      const results = await rt.produce(
        { operation: 'add', queue: rt.name, count: batch.length },
        (trace) =>
          admitEach(rt, batch.map(toItem), batch.map(toOptions), batch.map(toJob(rt, trace)))
      );
      batch.forEach((pending, index) => {
        const result = results[index]!;
        if (result.status === 'fulfilled') pending.resolve(result.value);
        else pending.reject(result.reason);
      });
    } catch (error) {
      this.#fail(batch, error);
    }
  }

  /** Rejects the jobs the store refuses on their own input; the rest go again, together. */
  #fail(batch: Pending[], error: unknown): void {
    const culprits = batch.length === 1 ? [] : batch.flatMap((p) => this.#invalid(p));
    if (culprits.length === 0) {
      for (const pending of batch) pending.reject(error);
      return;
    }
    const bad = new Set(culprits.map(([pending]) => pending));
    for (const [pending, reason] of culprits) pending.reject(reason);
    this.#pending.unshift(...batch.filter((pending) => !bad.has(pending)));
  }

  #invalid(pending: Pending): Array<[Pending, unknown]> {
    try {
      this.#rt.store.checkJobs([toJob(this.#rt, undefined)(pending)]);
      return [];
    } catch (reason) {
      return [[pending, reason]];
    }
  }
}

const toItem = (pending: Pending): BulkJob<unknown> => pending.item;
const toOptions = (pending: Pending): JobOptions => pending.merged;
const toJob =
  (rt: Runtime, trace: string | undefined) =>
  (pending: Pending): NewJob => ({
    queue: rt.name,
    name: pending.item.name,
    data: pending.item.data,
    options: pending.merged,
    ...(trace === undefined ? {} : { trace }),
  });
