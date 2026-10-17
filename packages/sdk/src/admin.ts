import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { PendingState } from '@qelay-cloud/store-postgres';
import { MAX_CLEAN_LIMIT } from '@qelay-cloud/store-postgres';
import { promoteJob } from './jobOps';
import type { Runtime } from './runtime';

/**
 * Queue-level actions: pause, and the three that delete jobs. Each deletion runs in bounded
 * batches, one transaction each, so a queue of any size never holds a long lock or a long
 * transaction. What a live flow parent waits on is never deleted (`FlowProtectedError` for
 * `obliterate`, skipped by `drain` and `clean`), and `obliterate` refuses a queue with an active job
 * unless it is forced.
 */

export async function pauseQueue(rt: Runtime): Promise<void> {
  await rt.store.pause(rt.name);
}

/** Jobs rung before the pause are rung again by the tick, within its interval; `resume` rings nothing itself. */
export async function resumeQueue(rt: Runtime): Promise<void> {
  await rt.store.resume(rt.name);
}

export async function isQueuePaused(rt: Runtime): Promise<boolean> {
  return (await rt.store.queues.config(rt.name)).paused;
}

/** Deletes the waiting, prioritized and delayed jobs. Returns how many. */
export async function drainQueue(rt: Runtime): Promise<number> {
  let removed = 0;
  for (;;) {
    const report = await rt.store.control.drain(rt.name);
    removed += report.removed.length;
    if (!report.more) return removed;
  }
}

/** Deletes the queue and everything of it. Throws `JobStateError` for an active job unless `force`. */
export async function obliterateQueue(
  rt: Runtime,
  options: { readonly force?: boolean } = {}
): Promise<void> {
  const force = options.force === true;
  for (;;) {
    const report = await rt.store.control.obliterate(rt.name, { force });
    if (report.done) return;
  }
}

const PENDING: Readonly<Record<string, PendingState>> = {
  wait: 'waiting',
  waiting: 'waiting',
  prioritized: 'prioritized',
  delayed: 'delayed',
};

/**
 * Deletes jobs of one state that were finished (or, for the pending states, created) at least
 * `grace` ms ago, at most `limit` of them (0: all). Returns their ids, oldest first.
 */
export async function cleanJobs(
  rt: Runtime,
  grace: number,
  limit: number,
  type = 'completed'
): Promise<string[]> {
  if (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0) {
    throw new UnsupportedOptionError('grace', 'must be a number of milliseconds, 0 or more');
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new UnsupportedOptionError('limit', 'must be an integer, 0 (all) or more');
  }
  if (type === 'active' || type === 'paused') {
    throw new UnsupportedOptionError(
      'type',
      type === 'active'
        ? '"active" is not cleaned: let its workers finish the jobs, or obliterate with force'
        : '"paused" is not a state: the waiting jobs of a paused queue are cleaned as "wait"'
    );
  }
  const pending = PENDING[type];
  if (pending === undefined && type !== 'completed' && type !== 'failed') {
    throw new UnsupportedOptionError(
      'type',
      `"${type}" is not a job state to clean (completed, failed, wait, prioritized, delayed)`
    );
  }
  const removed: string[] = [];
  const target = limit === 0 ? Number.POSITIVE_INFINITY : limit;
  while (removed.length < target) {
    const batch = Math.min(MAX_CLEAN_LIMIT, target - removed.length);
    const report =
      pending === undefined
        ? await rt.store.maintenance.clean(rt.name, {
            state: type as 'completed' | 'failed',
            olderThanMs: grace,
            limit: batch,
          })
        : await rt.store.control.cleanPending(rt.name, {
            state: pending,
            olderThanMs: grace,
            limit: batch,
          });
    removed.push(...report.removed);
    if (!report.more) break;
  }
  return removed;
}

/** Makes up to `count` delayed jobs (default 1,000) due now, soonest first. Returns how many it tried. */
export async function promoteJobs(rt: Runtime, count = 1_000): Promise<number> {
  if (!Number.isInteger(count) || count < 1 || count > 1_000) {
    throw new UnsupportedOptionError('count', 'must be an integer from 1 to 1000');
  }
  const page = await rt.store.readModels.jobsByState(rt.name, 'delayed', { limit: count });
  for (const job of page.items) await promoteJob(rt, job.id);
  return page.items.length;
}
