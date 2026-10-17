import type { Route } from '../http/router';
import {
  cleanBody,
  concurrencyBody,
  drainBody,
  obliterateBody,
  promoteJobsBody,
  rateLimitBody,
  requireConfirmation,
} from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import { cleanQueue, drainQueue, obliterateQueue, promoteDelayed } from '../jobs/queueActions';

/** The most `POST /queues/:queue/promote-jobs` promotes in one call when `count` is absent. */
const DEFAULT_PROMOTE = 100;

/**
 * Operator actions on a queue. Pause, resume and the two limits are plain settings, each one write.
 * Drain, clean and obliterate delete jobs for good, so each needs `confirm` set to the queue's name
 * (400 `confirmation_required` otherwise, before anything is read) and an operator, which every
 * `write` route already needs. They work in bounded batches under a time budget: `done: false`
 * means work is left and the same call continues it.
 *
 * Clean takes a `state` (`completed` by default, or `failed`, `waiting`, `prioritized`, `delayed`)
 * and a `grace` in ms. Obliterate refuses a queue with an active job (409) unless `force` is true.
 */
export function queueActionRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'POST',
      path: '/queues/:queue/pause',
      access: 'write',
      async handle(context) {
        await store.pause(context.params.queue!);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/resume',
      access: 'write',
      async handle(context) {
        await store.resume(context.params.queue!);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/drain',
      access: 'write',
      timeoutMs: ctx.config.actionBudgetMs + 10_000,
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(drainBody);
        requireConfirmation(queue, body?.confirm, 'drain');
        const result = await drainQueue(ctx, queue);
        return { ok: true, ...result };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/clean',
      access: 'write',
      timeoutMs: ctx.config.actionBudgetMs + 10_000,
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(cleanBody);
        requireConfirmation(queue, body?.confirm, 'clean');
        const result = await cleanQueue(ctx, queue, body ?? {});
        return { ok: true, ...result };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/obliterate',
      access: 'write',
      timeoutMs: ctx.config.actionBudgetMs + 10_000,
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(obliterateBody);
        requireConfirmation(queue, body?.confirm, 'obliterate');
        const result = await obliterateQueue(ctx, queue, body?.force === true);
        return { ok: true, ...result };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/promote-jobs',
      access: 'write',
      timeoutMs: ctx.config.actionBudgetMs + 10_000,
      async handle(context) {
        const body = await context.json(promoteJobsBody);
        const result = await promoteDelayed(
          ctx,
          context.params.queue!,
          body?.count ?? DEFAULT_PROMOTE
        );
        return { ok: true, ...result };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/rate-limit',
      access: 'write',
      async handle(context) {
        const body = await context.json(rateLimitBody);
        await store.setRateLimit(context.params.queue!, {
          max: body.limit,
          ...(body.duration === undefined ? {} : { durationMs: body.duration }),
          ...(body.ttl === undefined ? {} : { ttlMs: body.ttl }),
        });
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/queues/:queue/rate-limit',
      access: 'write',
      async handle(context) {
        await store.setRateLimit(context.params.queue!, null);
        return { ok: true };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/concurrency',
      access: 'write',
      async handle(context) {
        const body = await context.json(concurrencyBody);
        await store.setConcurrencyLimit(context.params.queue!, body.concurrency);
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/queues/:queue/concurrency',
      access: 'write',
      async handle(context) {
        await store.setConcurrencyLimit(context.params.queue!, null);
        return { ok: true };
      },
    },
  ];
}
