import type { DlqRetryRefusal } from '@qelay-cloud/core';
import { MAX_DLQ_RETRY } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import { fencedBody, purgeDlqBody, requireConfirmation, retryDlqBody } from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import { explainRefusal, jobNotFound } from '../jobs/context';
import type { DlqEntryWire } from '../jobs/dlqModel';
import { toDlqEntryWire, toDlqStatsWire } from '../jobs/dlqModel';
import { ringAfterCommit } from '../jobs/ring';

const dlqQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Entries one purge call deletes per transaction. */
const PURGE_BATCH = 500;

/**
 * The dead-letter queue of a queue: its failed jobs, newest failure last, each with how it failed.
 * Reading is paged and bounded like the job lists (a payload over the list budget is a marker).
 * Purging needs `confirm` with the queue's name and works in bounded transactions under the same
 * time budget as drain, answering `done: false` when it stopped with entries left.
 *
 * Retrying (D16) puts a failed job back as waiting with no attempt used, in a new `version`, and rings
 * it. One entry takes `expectedVersion` like the other job actions: 404 `job_not_found`, 409
 * `version_conflict`, 409 `job_state` (it is not failed, for example because another caller retried it
 * first), 409 `flow_member` (retry the flow instead) and 409 `duplicate_job` (a live job holds its
 * dedup key) each change nothing. A set is `limit` entries (at most 500, one transaction), oldest
 * failure first, optionally one `reason`, and needs `confirm` with the queue's name; the answer's
 * `remaining` is what a repeat call would still retry. Nothing retries by itself (`dlq-auto-retry`).
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
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(retryDlqBody);
        requireConfirmation(queue, body?.confirm, 'retry', 'puts failed jobs back in the queue');
        context.audit(
          `dlqRetry limit=${body?.limit ?? MAX_DLQ_RETRY} reason=${body?.reason ?? '*'}`
        );
        const result = await store.retryDlqMany(queue, {
          limit: body?.limit ?? MAX_DLQ_RETRY,
          ...(body?.reason === undefined ? {} : { reason: body.reason }),
        });
        await ringAfterCommit(store, ctx.transport, ctx.logger, result.rings);
        return {
          ok: true,
          count: result.retried.length,
          remaining: result.remaining,
          done: result.remaining === 0,
        };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/dlq/:jobId/retry',
      access: 'write',
      async handle(context) {
        const { queue, jobId } = context.params as { queue: string; jobId: string };
        const body = await context.json(fencedBody);
        const expectedVersion = body?.expectedVersion;
        const result = await store.retryDlq(
          queue,
          jobId,
          expectedVersion === undefined ? {} : { expectedVersion }
        );
        if (!result.ok) return refuse(ctx, result.reason, jobId, expectedVersion);
        await ringAfterCommit(store, ctx.transport, ctx.logger, result.rings);
        return { ok: true };
      },
    },
  ];
}

/** The answer for a retry the store refused: every one is a 4xx and nothing changed. */
function refuse(
  ctx: JobsContext,
  reason: DlqRetryRefusal,
  jobId: string,
  expectedVersion: number | undefined
): Promise<never> {
  switch (reason) {
    case 'not_found':
      throw jobNotFound(jobId);
    case 'version':
      throw new ApiError(
        409,
        'version_conflict',
        'the job changed since it was read, so nothing was changed',
        { jobId, expectedVersion }
      );
    case 'flow_member':
      throw new ApiError(
        409,
        'flow_member',
        'the job belongs to a flow: retry the flow (POST /flows/:id/actions, retry-failed) instead',
        { jobId }
      );
    case 'duplicate':
      throw new ApiError(
        409,
        'duplicate_job',
        'a live job holds the same deduplication key, so this one cannot be waiting too',
        { jobId }
      );
    case 'not_failed':
      return explainRefusal(ctx, jobId);
  }
}
