import type { PendingState } from '@qelay-cloud/store-postgres';
import { MAX_CLEAN_LIMIT } from '@qelay-cloud/store-postgres';
import type { z } from 'zod';
import type { cleanBody } from './actionSchemas';
import type { JobsContext } from './context';
import { ringAfterCommit } from './ring';

/**
 * The queue-level actions that delete or promote many jobs. Each runs the store's bounded batches
 * (one transaction each, so no action holds a lock for long) until the work is done or the call's
 * time budget (`actionBudgetMs`) is spent. A call that stopped early answers `done: false` with what
 * it did, and calling it again continues: every batch is safe to repeat.
 */

export interface ActionResult {
  /** Jobs deleted (or promoted) by this call. */
  readonly count: number;
  /** False when work is left: call again. */
  readonly done: boolean;
}

const PENDING: Readonly<Record<string, PendingState>> = {
  wait: 'waiting',
  waiting: 'waiting',
  prioritized: 'prioritized',
  delayed: 'delayed',
};

type CleanRequest = NonNullable<z.infer<typeof cleanBody>>;

/** Deletes the waiting, prioritized and delayed jobs. */
export async function drainQueue(ctx: JobsContext, queue: string): Promise<ActionResult> {
  const deadline = ctx.clock.now() + ctx.config.actionBudgetMs;
  let count = 0;
  for (;;) {
    const report = await ctx.store.control.drain(queue);
    count += report.removed.length;
    if (!report.more) return { count, done: true };
    if (ctx.clock.now() >= deadline) return { count, done: false };
  }
}

/**
 * Deletes jobs of one state that finished (or, for the pending states, were created) at least
 * `grace` ms ago, at most `limit` of them (absent or 0: all that are eligible).
 */
export async function cleanQueue(
  ctx: JobsContext,
  queue: string,
  request: Pick<CleanRequest, 'grace' | 'state' | 'limit'>
): Promise<ActionResult> {
  const state = request.state ?? 'completed';
  const grace = request.grace ?? 0;
  const target = request.limit === undefined || request.limit === 0 ? Infinity : request.limit;
  const pending = PENDING[state];
  const deadline = ctx.clock.now() + ctx.config.actionBudgetMs;
  let count = 0;
  while (count < target) {
    const batch = Math.min(MAX_CLEAN_LIMIT, target - count);
    const report =
      pending === undefined
        ? await ctx.store.maintenance.clean(queue, {
            state: state as 'completed' | 'failed',
            olderThanMs: grace,
            limit: batch,
          })
        : await ctx.store.control.cleanPending(queue, {
            state: pending,
            olderThanMs: grace,
            limit: batch,
          });
    count += report.removed.length;
    if (!report.more) return { count, done: true };
    if (ctx.clock.now() >= deadline) return { count, done: false };
  }
  // The limit was reached: the caller asked for no more, so the call is complete.
  return { count, done: true };
}

/** Deletes the queue and everything of it. An active job is an error (409) unless `force`. */
export async function obliterateQueue(
  ctx: JobsContext,
  queue: string,
  force: boolean
): Promise<ActionResult> {
  const deadline = ctx.clock.now() + ctx.config.actionBudgetMs;
  let count = 0;
  for (;;) {
    const report = await ctx.store.control.obliterate(queue, { force });
    count += report.removed;
    if (report.done) return { count, done: true };
    if (ctx.clock.now() >= deadline) return { count, done: false };
  }
}

/** Makes up to `limit` delayed jobs due now, soonest first, and rings the ones that became ready. */
export async function promoteDelayed(
  ctx: JobsContext,
  queue: string,
  limit: number
): Promise<ActionResult> {
  const page = await ctx.store.readModels.jobsByState(queue, 'delayed', { limit });
  const rings = [];
  let count = 0;
  for (const job of page.items) {
    const outcome = await ctx.store.promote(job.id);
    if (!outcome.ok) continue;
    count += 1;
    rings.push(...outcome.rings);
  }
  await ringAfterCommit(ctx.store, ctx.transport, ctx.logger, rings);
  return { count, done: page.total <= page.items.length };
}
