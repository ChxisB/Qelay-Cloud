import { z } from 'zod';
import type { OverviewResponse as PanelOverview, StatsResponse as PanelStats } from './panel-types';

/**
 * Runtime schemas for what the panel reads. Each `satisfies z.ZodType<...>` makes the compiler check
 * the schema against the panel's own type, so a schema that forgets a field the panel needs does not
 * compile. Extra fields are allowed, as the panel allows them.
 */
const count = z.number();
const overviewStats = z.object({
  waiting: count,
  active: count,
  delayed: count,
  completed: count,
  dlq: count,
  totalPushed: count,
  totalPulled: count,
  totalCompleted: count,
  totalFailed: count,
  uptime: count,
});
const memory = z.object({ heapUsed: count, heapTotal: count, rss: count });

export const overviewSchema = z.object({
  ok: z.boolean(),
  stats: overviewStats,
  throughput: z.object({
    pushPerSec: count,
    pullPerSec: count,
    completePerSec: count,
    failPerSec: count,
  }),
  latency: z.object({
    averages: z.record(z.string(), count),
    percentiles: z.record(z.string(), z.object({ p50: count, p95: count, p99: count })),
  }),
  memory,
  collections: z.record(z.string(), count),
  workers: z.object({
    total: count,
    active: count,
    list: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        queues: z.array(z.string()),
        lastSeen: count,
        activeJobs: count,
        processedJobs: count,
        failedJobs: count,
      })
    ),
    truncated: z.boolean(),
  }),
  crons: z.object({
    total: count,
    list: z.array(
      z.object({
        name: z.string(),
        queue: z.string(),
        schedule: z.string().nullable(),
        repeatEvery: count.nullable(),
        nextRun: count,
        executions: count,
      })
    ),
    truncated: z.boolean(),
  }),
  storage: z
    .object({
      diskFull: z.boolean().optional(),
      error: z.string().nullable().optional(),
      since: count.nullable().optional(),
    })
    .catchall(z.unknown()),
  timestamp: count,
}) satisfies z.ZodType<PanelOverview>;

export const statsSchema = z.object({
  ok: z.boolean(),
  stats: overviewStats
    .extend({
      prioritized: count,
      'waiting-children': count,
      pushPerSec: count,
      pullPerSec: count,
      completePerSec: count,
      failPerSec: count,
    })
    .catchall(count),
  memory: memory.extend({ external: count, arrayBuffers: count }),
  collections: z.record(z.string(), count),
}) satisfies z.ZodType<PanelStats>;

/** `GET /capabilities` is new to this service; the panel's own type for it is `src/lib/capabilities/types.ts`. */
export const capabilitiesSchema = z.object({
  transport: z.object({
    name: z.string(),
    maxDeliverDelayMs: z.number().int().min(0).nullable(),
    ordering: z.enum(['none', 'best-effort']),
  }),
  features: z.object({
    dlq: z.boolean(),
    cron: z.boolean(),
    flows: z.boolean(),
    workflows: z.boolean(),
    webhooks: z.boolean(),
  }),
  hidden: z.array(z.string()),
  unsupported: z.array(z.string()),
  principal: z.object({ role: z.enum(['viewer', 'operator']) }),
  version: z.string(),
});

export const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[a-z][a-z0-9_]*$/),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
