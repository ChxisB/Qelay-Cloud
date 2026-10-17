import { z } from 'zod';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import { purgeDlqBody, requireConfirmation } from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import type { DlqEntryWire } from '../jobs/dlqModel';
import { toDlqEntryWire, toDlqStatsWire } from '../jobs/dlqModel';

const dlqQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Entries one purge call deletes per transaction. */
const PURGE_BATCH = 500;

const retryClosed = (): never => {
  throw ApiError.notSupported(
    'dlq-retry',
    'a failed job is not requeued from the DLQ: retrying it needs a job-generation, state and flow precondition that is not built yet'
  );
};

/**
 * The dead-letter queue of a queue: its failed jobs, newest failure last, each with how it failed.
 * Reading is paged and bounded like the job lists (a payload over the list budget is a marker).
 * Purging needs `confirm` with the queue's name and works in bounded transactions under the same
 * time budget as drain, answering `done: false` when it stopped with entries left.
 *
 * Retrying an entry stays closed (501 `dlq-retry`): `GET /capabilities` lists it under `unsupported`
 * so the panel leaves the button out.
 */
export function dlqRoutes(ctx: JobsContext): Route[] {
  const { store, config } = ctx;

  return [
    {
      method: 'GET',
      path: '/queues/:queue/dlq',
      access: 'read',
      async handle(context) {
        const queue = context.params.queue!;
        const query = context.query(dlqQuery);
        const limit = Math.min(query.limit ?? config.defaultPageSize, config.maxPageSize);
        const offset = query.offset ?? 0;
        if (offset > config.maxOffset) {
          throw new ApiError(400, 'offset_too_large', 'offset is past what a list walks', {
            maxOffset: config.maxOffset,
            use: 'GET /queues/:queue/jobs/list?states=failed&cursor=',
          });
        }
        const page = await store.listDlqPage(queue, { limit, offset });
        const ids = page.items.map((entry) => entry.jobId);
        const [details, failures, settings] = await Promise.all([
          store.control.detailsMany(ids),
          store.control.failuresMany(ids),
          store.queues.config(queue),
        ]);
        const byId = new Map(details.map((job) => [job.id, job]));
        // A job that left the DLQ between the two reads is left out; `total` is the count that was read.
        const entries: DlqEntryWire[] = [];
        for (const id of ids) {
          const job = byId.get(id);
          if (job?.state !== 'failed') continue;
          entries.push(
            toDlqEntryWire(job, failures.get(id) ?? null, {
              payloadBytes: config.listPayloadBytes,
              maxAge: settings.dlq.maxAge,
            })
          );
        }
        return { ok: true, entries, total: page.total, limit, offset };
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/dlq/stats',
      access: 'read',
      async handle(context) {
        const queue = context.params.queue!;
        return { ok: true, stats: toDlqStatsWire(queue, await store.dlqStats(queue)) };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/dlq/purge',
      access: 'write',
      timeoutMs: config.actionBudgetMs + 10_000,
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(purgeDlqBody);
        requireConfirmation(queue, body?.confirm, 'purge');
        const deadline = ctx.clock.now() + config.actionBudgetMs;
        let count = 0;
        for (;;) {
          const page = await store.listDlqPage(queue, { limit: PURGE_BATCH });
          if (page.items.length === 0) return { ok: true, count, done: true };
          const removed = await store.purgeDlq(
            queue,
            page.items.map((entry) => entry.jobId)
          );
          count += removed;
          if (page.total - removed <= 0) return { ok: true, count, done: true };
          // Nothing deleted means every entry of the page is held by another transaction: stop.
          if (removed === 0 || ctx.clock.now() >= deadline) return { ok: true, count, done: false };
        }
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/dlq/retry',
      access: 'write',
      handle: retryClosed,
    },
    {
      method: 'POST',
      path: '/queues/:queue/dlq/:jobId/retry',
      access: 'write',
      handle: retryClosed,
    },
  ];
}
