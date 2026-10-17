import { MAX_PAGE_SIZE } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { wantsFresh } from '../cache';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { MAX_QUEUE_OFFSET } from '../jobs/limits';
import { toCountsWire, toSummaryWire } from '../jobs/model';
import { toWire } from '../jobs/payload';

/** Response header of `GET /queues/summary` when more queues follow: pass it back as `after`. */
export const NEXT_CURSOR_HEADER = 'x-next-cursor';

/** Jobs of each list of the queue page, and the failed jobs it previews. */
const DETAIL_JOBS = 20;
const DLQ_PREVIEW = 10;

const summaryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  after: z.string().min(1).max(256).optional(),
});

const queuesQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const detailQuery = z.object({ includeJobs: z.enum(['true', 'false']).optional() });

/**
 * The read side of the queues: summaries, counts and the dashboard's queue list and page. Every one
 * is an index-only aggregate over the state indexes, a read of one queue's row, or a page of at most
 * `DETAIL_JOBS` jobs: never a scan of the jobs' rows. The two the panel polls are kept by `ctx.cache`
 * for a short time.
 */
export function queueReadRoutes(ctx: JobsContext): Route[] {
  const { store, config } = ctx;

  const summary = (after: string | undefined, limit: number, bypass: boolean) => {
    const read = () =>
      store.readModels.queueSummaries({ limit, ...(after === undefined ? {} : { after }) });
    // Only the answer of the plain call is kept: `after` is the caller's, so keys would be unbounded.
    return after === undefined && limit === MAX_PAGE_SIZE
      ? ctx.cache.get('queues-summary', read, bypass)
      : read();
  };

  return [
    {
      method: 'GET',
      path: '/queues/summary',
      access: 'read',
      async handle(context) {
        const query = context.query(summaryQuery);
        const page = await summary(
          query.after,
          query.limit ?? MAX_PAGE_SIZE,
          wantsFresh(context.request)
        );
        return Response.json(page.items.map(toSummaryWire), {
          headers: page.next === null ? {} : { [NEXT_CURSOR_HEADER]: page.next },
        });
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/counts',
      access: 'read',
      async handle(context) {
        const queue = context.params.queue!;
        const [counts, state] = await Promise.all([
          store.counts(queue),
          store.queues.config(queue),
        ]);
        return { ok: true, counts: toCountsWire(counts, state.paused) };
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/paused',
      access: 'read',
      async handle(context) {
        const state = await store.queues.config(context.params.queue!);
        return { ok: true, paused: state.paused };
      },
    },
    {
      method: 'GET',
      path: '/dashboard/queues',
      access: 'read',
      async handle(context) {
        const query = context.query(queuesQuery);
        const limit = Math.min(query.limit ?? config.defaultPageSize, config.maxPageSize);
        const offset = query.offset ?? 0;
        if (offset > MAX_QUEUE_OFFSET) {
          throw new ApiError(400, 'offset_too_large', `offset is limited to ${MAX_QUEUE_OFFSET}`, {
            maxOffset: MAX_QUEUE_OFFSET,
          });
        }
        const totals = await store.readModels.dashboard();
        const queues = [];
        let index = 0;
        let after: string | undefined;
        for (;;) {
          const page = await store.readModels.queueSummaries({
            limit: MAX_PAGE_SIZE,
            ...(after === undefined ? {} : { after }),
          });
          for (const item of page.items) {
            if (index >= offset && queues.length < limit) {
              queues.push({
                name: item.queue,
                waiting: item.counts.waiting,
                delayed: item.counts.delayed,
                active: item.counts.active,
                dlq: item.counts.failed,
                paused: item.paused,
              });
            }
            index += 1;
          }
          if (queues.length >= limit || page.next === null) break;
          after = page.next;
        }
        return {
          ok: true,
          queues,
          total: totals.queues,
          limit,
          offset,
          timestamp: ctx.clock.now(),
        };
      },
    },
    {
      method: 'GET',
      path: '/dashboard/queues/:queue',
      access: 'read',
      async handle(context) {
        const queue = context.params.queue!;
        const includeJobs = context.query(detailQuery).includeJobs !== 'false';
        const [counts, state, priorityCounts, failed] = await Promise.all([
          store.counts(queue),
          store.queues.config(queue),
          store.readModels.priorityCounts(queue),
          store.readModels.jobsByState(queue, 'failed', { limit: DLQ_PREVIEW }),
        ]);
        const lists = includeJobs ? await jobLists(ctx, queue, state.paused) : undefined;
        return {
          ok: true,
          name: queue,
          counts: toCountsWire(counts, state.paused),
          paused: state.paused,
          priorityCounts,
          dlqPreview: failed.items.map((job) => ({
            id: job.id,
            data: toWire(job.data, { maxBytes: config.listPayloadBytes }).value,
            attempts: job.attempts,
            createdAt: job.createdAt,
          })),
          ...(lists === undefined ? {} : { jobs: lists }),
          timestamp: ctx.clock.now(),
        };
      },
    },
  ];
}

interface JobSummaryWire {
  readonly id: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly runAt: number;
  readonly attempts: number;
  readonly progress: number;
}

/**
 * The first jobs of each list the queue page shows. `paused` holds what a pause keeps back (the
 * waiting and prioritized jobs) and is empty while the queue runs. The progress of all of them comes
 * from one read of the jobs by id.
 */
async function jobLists(ctx: JobsContext, queue: string, paused: boolean) {
  const { readModels, control } = ctx.store;
  const page = { limit: DETAIL_JOBS };
  const [waiting, active, delayed, prioritized] = await Promise.all([
    readModels.jobsByState(queue, 'waiting', page),
    readModels.jobsByState(queue, 'active', page),
    readModels.jobsByState(queue, 'delayed', page),
    paused ? readModels.jobsByState(queue, 'prioritized', page) : null,
  ]);
  const held = paused
    ? [...waiting.items, ...(prioritized?.items ?? [])].slice(0, DETAIL_JOBS)
    : [];
  const ids = [
    ...new Set([...waiting.items, ...active.items, ...delayed.items, ...held].map((job) => job.id)),
  ];
  const progress = new Map(
    (await control.detailsMany(ids)).map((job) => [job.id, job.progress] as const)
  );
  const summarize = (jobs: readonly (typeof waiting.items)[number][]): JobSummaryWire[] =>
    jobs.map((job) => ({
      id: job.id,
      priority: job.priority,
      createdAt: job.createdAt,
      runAt: job.runAt,
      attempts: job.attempts,
      progress: progress.get(job.id) ?? 0,
    }));
  return {
    waiting: summarize(paused ? [] : waiting.items),
    active: summarize(active.items),
    delayed: summarize(delayed.items),
    paused: summarize(held),
  };
}
