import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { NAMESPACE_TOTALS, THROUGHPUT_BUCKETS, THROUGHPUT_TOTALS } from './readQueries';

/**
 * What the panel's throughput chart reads: jobs completed and failed per minute, and lifetime
 * totals. The writes are `recordMetrics` (`metrics.ts`), inside the transaction that finished the
 * jobs. Adapted from Qelay's `telemetry.ts` (see docs/PORTING.md). Upstream returned a newest-first
 * array per metric and the latest minute's count; here a read is one dense series, oldest first,
 * both metrics aligned, from two bounded index reads.
 */

const MINUTE_MS = 60_000;
export const DEFAULT_THROUGHPUT_MINUTES = 60;
/** Fourteen days: what the buckets keep by default. A longer range only adds empty minutes. */
export const MAX_THROUGHPUT_MINUTES = 20_160;

export interface ThroughputPoint {
  /** The start of the minute, in epoch milliseconds. */
  readonly minute: number;
  readonly completed: number;
  readonly failed: number;
}

export interface Throughput {
  readonly queue: string;
  /** Oldest first, one point per minute, zero where nothing finished. The last is the minute of `until`. */
  readonly points: readonly ThroughputPoint[];
  /** Since the queue began, whether or not the minute buckets still hold them. */
  readonly totals: { readonly completed: number; readonly failed: number };
}

interface BucketRow {
  metric_type: 'completed' | 'failed';
  minute: number | string | bigint;
  count: number;
}

/**
 * The last `minutes` minutes (default 60) up to and including the minute of `until` (default now,
 * from the store's clock). A bucket is written in the minute the job finished, so the newest point
 * may still grow.
 */
export async function throughput(
  ctx: StoreContext,
  queue: string,
  range: { readonly minutes?: number; readonly until?: number } = {}
): Promise<Throughput> {
  const name = identifier('queue', queue);
  const minutes = range.minutes ?? DEFAULT_THROUGHPUT_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_THROUGHPUT_MINUTES) {
    throw new UnsupportedOptionError(
      'minutes',
      `must be an integer from 1 to ${MAX_THROUGHPUT_MINUTES}`
    );
  }
  if (range.until !== undefined && !Number.isSafeInteger(range.until)) {
    throw new UnsupportedOptionError('until', 'must be a timestamp in milliseconds');
  }
  return ctx.db.run('throughput', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const last = Math.floor((range.until ?? now) / MINUTE_MS);
    const first = last - minutes + 1;
    // The tick deletes buckets past the retention; one it has not reached yet is not shown.
    const oldest = Math.floor(now / MINUTE_MS) - ctx.maxMetricBuckets + 1;
    const [buckets, totals] = await Promise.all([
      sql.unsafe<BucketRow[]>(THROUGHPUT_BUCKETS, [
        ctx.namespace,
        name,
        Math.max(first, oldest),
        last,
      ]),
      sql.unsafe<
        Array<{ metric_type: 'completed' | 'failed'; total_count: number | string | bigint }>
      >(THROUGHPUT_TOTALS, [ctx.namespace, name]),
    ]);
    const series = {
      completed: new Array<number>(minutes).fill(0),
      failed: new Array<number>(minutes).fill(0),
    };
    for (const row of buckets) {
      const index = Number(row.minute) - first;
      if (index >= 0 && index < minutes) series[row.metric_type][index] = row.count;
    }
    const points = series.completed.map((completed, index) => ({
      minute: (first + index) * MINUTE_MS,
      completed,
      failed: series.failed[index]!,
    }));
    const total = (type: 'completed' | 'failed'): number =>
      Number(totals.find((row) => row.metric_type === type)?.total_count ?? 0);
    return {
      queue: name,
      points,
      totals: { completed: total('completed'), failed: total('failed') },
    };
  });
}

/** Jobs completed and failed since each queue began, summed over every queue of the namespace. */
export interface NamespaceTotals {
  readonly completed: number;
  readonly failed: number;
}

/** What the dashboard's lifetime figures read: one grouped read of at most two rows per queue. */
export async function namespaceTotals(ctx: StoreContext): Promise<NamespaceTotals> {
  return ctx.db.run('namespaceTotals', async (sql) => {
    const rows = await sql.unsafe<
      Array<{ metric_type: 'completed' | 'failed'; total: number | string | bigint }>
    >(NAMESPACE_TOTALS, [ctx.namespace]);
    const total = (type: 'completed' | 'failed'): number =>
      Number(rows.find((row) => row.metric_type === type)?.total ?? 0);
    return { completed: total('completed'), failed: total('failed') };
  });
}
