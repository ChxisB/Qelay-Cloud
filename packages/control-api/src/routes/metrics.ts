import { z } from 'zod';
import { wantsFresh } from '../cache';
import type { DashboardReader } from '../deps';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';

const MINUTE_MS = 60_000;
/** Minutes one point may stand for. */
const RESOLUTIONS = [1, 5, 15, 60] as const;
const DEFAULT_MINUTES = 60;

const seriesQuery = z.object({
  minutes: z.coerce.number().int().min(1).optional(),
  resolution: z.coerce
    .number()
    .int()
    .refine((value) => RESOLUTIONS.some((allowed) => allowed === value), {
      message: `one of ${RESOLUTIONS.join(', ')}`,
    })
    .optional(),
  until: z.coerce.number().int().min(0).optional(),
});

/**
 * `GET /metrics` is the panel's four counters. `GET /metrics/queues/:queue` is the queue's jobs
 * completed and failed over time, from the minute buckets the store writes in the transaction that
 * finishes a job: `minutes` back from `until` (default now, at most `maxMetricsMinutes`), summed
 * into `resolution`-minute points (1, 5, 15 or 60; each point is the start of its window).
 *
 * Only what is counted is served. Latency and wait-time percentiles are not recorded, so they are
 * not in the response and not estimated.
 */
export function metricsRoutes(ctx: JobsContext, dashboard: DashboardReader): Route[] {
  const { store, config } = ctx;

  return [
    {
      method: 'GET',
      path: '/metrics',
      access: 'read',
      async handle(context) {
        const { stats } = await dashboard.stats({ fresh: wantsFresh(context.request) });
        return {
          ok: true,
          metrics: {
            totalPushed: stats.totalPushed,
            totalPulled: stats.totalPulled,
            totalCompleted: stats.totalCompleted,
            totalFailed: stats.totalFailed,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/metrics/queues/:queue',
      access: 'read',
      async handle(context) {
        const queue = context.params.queue!;
        const query = context.query(seriesQuery);
        const minutes = query.minutes ?? DEFAULT_MINUTES;
        const resolution = query.resolution ?? 1;
        if (minutes > config.maxMetricsMinutes) {
          throw new ApiError(400, 'range_too_large', 'minutes is past what one read covers', {
            maxMinutes: config.maxMetricsMinutes,
          });
        }
        const series = await store.metrics.throughput(queue, {
          minutes,
          ...(query.until === undefined ? {} : { until: query.until }),
        });
        const window = resolution * MINUTE_MS;
        const points: Array<{ timestamp: number; completed: number; failed: number }> = [];
        for (const point of series.points) {
          const start = Math.floor(point.minute / window) * window;
          const last = points.at(-1);
          if (last?.timestamp === start) {
            last.completed += point.completed;
            last.failed += point.failed;
          } else {
            points.push({ timestamp: start, completed: point.completed, failed: point.failed });
          }
        }
        return {
          ok: true,
          queue,
          minutes,
          resolution,
          points,
          totals: series.totals,
        };
      },
    },
  ];
}
