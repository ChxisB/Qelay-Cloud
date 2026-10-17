import type { StateCounts } from '@qelay-cloud/core';
import type { CronRecord, WorkerInfo } from '@qelay-cloud/store-postgres';
import type { DashboardReader } from '../deps';
import type {
  CronSummary,
  MemoryFigures,
  OverviewResponse,
  OverviewStats,
  StatsResponse,
  ThroughputRates,
  WorkerSummary,
} from '../types';
import type { JobsContext } from './context';

/** Longest worker and cron lists of the overview; `truncated` says when there were more. */
const LIST_CAP = 50;

interface Facts {
  readonly at: number;
  readonly queues: number;
  readonly pausedQueues: number;
  readonly counts: StateCounts;
  readonly completed: number;
  readonly failed: number;
  readonly workers: readonly WorkerInfo[];
  readonly crons: readonly CronRecord[];
}

interface Totals {
  readonly at: number;
  readonly pushed: number;
  readonly pulled: number;
  readonly completed: number;
  readonly failed: number;
}

const memoryNow = (): MemoryFigures & { external: number; arrayBuffers: number } => {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
};

const workerSummary = (worker: WorkerInfo): WorkerSummary => ({
  id: worker.id,
  name: worker.name,
  queues: worker.queues,
  lastSeen: worker.lastSeen,
  activeJobs: worker.activeJobs,
  processedJobs: worker.processed,
  failedJobs: worker.failed,
});

const cronSummary = (cron: CronRecord): CronSummary => ({
  name: cron.name,
  queue: cron.queue,
  schedule: cron.schedule,
  repeatEvery: cron.repeatEvery,
  nextRun: cron.nextRun,
  executions: cron.executions,
});

/**
 * `GET /dashboard` and `GET /stats` from the store's read models, in one pass each of four bounded
 * reads: the per-state counts of the namespace (one aggregate over the jobs' state indexes, never
 * their rows), the lifetime completed and failed totals, the worker registry and the crons.
 *
 * `totalCompleted` and `totalFailed` are the lifetime counters. `totalPulled` (every job that has
 * been claimed) and `totalPushed` (every job that was added and still counts) are derived from
 * those and the live counts, because the store keeps no counter of either: a job that is retried
 * is pulled once here. The per-second rates are the change since the previous read of this
 * process, so they are 0 on the first read and meaningful when the panel polls.
 */
export function createDashboardReader(ctx: JobsContext, startedAt: number): DashboardReader {
  /** One baseline for each answer, so polling `/stats` does not shorten the window of `/dashboard`. */
  const baselines: Record<'overview' | 'stats', Totals | null> = { overview: null, stats: null };

  async function load(): Promise<Facts> {
    const at = ctx.clock.now();
    const summary = await ctx.store.readModels.dashboard();
    const done = await ctx.store.metrics.totals();
    const workers = await ctx.store.workers.list();
    const crons = await ctx.store.crons.list();
    return {
      at,
      queues: summary.queues,
      pausedQueues: summary.pausedQueues,
      counts: summary.counts,
      completed: done.completed,
      failed: done.failed,
      workers,
      crons,
    };
  }

  function stats(
    facts: Facts,
    kind: 'overview' | 'stats'
  ): { stats: OverviewStats; rates: ThroughputRates } {
    const previous = baselines[kind];
    const { counts } = facts;
    const pulled = facts.completed + facts.failed + counts.active;
    const pushed =
      pulled + counts.waiting + counts.prioritized + counts.delayed + counts['waiting-children'];
    const seconds = previous === null ? 0 : (facts.at - previous.at) / 1_000;
    const rate = (now: number, before: number | undefined): number =>
      previous === null || seconds <= 0 || before === undefined
        ? 0
        : Math.max(0, now - before) / seconds;
    const rates: ThroughputRates = {
      pushPerSec: rate(pushed, previous?.pushed),
      pullPerSec: rate(pulled, previous?.pulled),
      completePerSec: rate(facts.completed, previous?.completed),
      failPerSec: rate(facts.failed, previous?.failed),
    };
    baselines[kind] = {
      at: facts.at,
      pushed,
      pulled,
      completed: facts.completed,
      failed: facts.failed,
    };
    return {
      rates,
      stats: {
        waiting: counts.waiting,
        active: counts.active,
        delayed: counts.delayed,
        completed: counts.completed,
        dlq: counts.failed,
        totalPushed: pushed,
        totalPulled: pulled,
        totalCompleted: facts.completed,
        totalFailed: facts.failed,
        uptime: Math.max(0, Math.floor((facts.at - startedAt) / 1_000)),
      },
    };
  }

  const collections = (facts: Facts): Record<string, number> => ({
    queues: facts.queues,
    pausedQueues: facts.pausedQueues,
    workers: facts.workers.length,
    crons: facts.crons.length,
  });

  return {
    overview: (options) =>
      ctx.cache.get(
        'overview',
        async (): Promise<OverviewResponse> => {
          const facts = await load();
          const { stats: figures, rates } = stats(facts, 'overview');
          const { external: _external, arrayBuffers: _buffers, ...memory } = memoryNow();
          const byRecency = [...facts.workers].sort((a, b) => b.lastSeen - a.lastSeen);
          return {
            ok: true,
            stats: figures,
            throughput: rates,
            latency: { averages: {}, percentiles: {} },
            memory,
            collections: collections(facts),
            workers: {
              total: facts.workers.length,
              active: facts.workers.filter((worker) => worker.active).length,
              list: byRecency.slice(0, LIST_CAP).map(workerSummary),
              truncated: byRecency.length > LIST_CAP,
            },
            crons: {
              total: facts.crons.length,
              list: facts.crons.slice(0, LIST_CAP).map(cronSummary),
              truncated: facts.crons.length > LIST_CAP,
            },
            storage: { engine: 'postgres', diskFull: false, error: null, since: null },
            timestamp: facts.at,
          };
        },
        options?.fresh === true
      ),
    stats: (options) =>
      ctx.cache.get(
        'stats',
        async (): Promise<StatsResponse> => {
          const facts = await load();
          const { stats: figures, rates } = stats(facts, 'stats');
          return {
            ok: true,
            stats: {
              ...figures,
              ...rates,
              prioritized: facts.counts.prioritized,
              'waiting-children': facts.counts['waiting-children'],
            },
            memory: memoryNow(),
            collections: collections(facts),
          };
        },
        options?.fresh === true
      ),
  };
}
