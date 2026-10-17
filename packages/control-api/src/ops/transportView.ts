import { deadLetterOldestAgeMs } from '@qelay-cloud/core';
import type { TransportStats } from '@qelay-cloud/core';
import type { Freshness, TransportQueueStats, TransportResponse } from '../opsTypes';
import type { OpsContext } from './context';
import { scanDoorbells } from './doorbells';

/** Queues whose broker numbers are read at once: Cloud Monitoring is one request per queue. */
const STATS_CONCURRENCY = 8;

const UNAVAILABLE = 'unavailable';

/** What a transport that could not answer is shown as: every number unknown. */
const unavailable = (now: number): TransportStats => ({
  depth: null,
  inFlight: null,
  delayed: null,
  oldestAgeMs: null,
  deadLetterDepth: null,
  source: UNAVAILABLE,
  observedAt: now,
  maxStalenessMs: 0,
});

/**
 * An all-null reading is "unknown", whatever time it carries: a transport that read nothing has not
 * observed anything, so `observedAt` and `ageMs` are null and the panel does not label zero numbers
 * with an age.
 */
function freshnessOf(stats: TransportStats, now: number): Freshness {
  const readNothing =
    stats.depth === null &&
    stats.oldestAgeMs === null &&
    stats.deadLetterDepth === null &&
    stats.inFlight === null;
  if (readNothing) {
    return {
      observedAt: null,
      ageMs: null,
      maxStalenessMs: stats.maxStalenessMs,
      source: stats.source,
    };
  }
  return {
    observedAt: stats.observedAt,
    ageMs: Math.max(0, now - stats.observedAt),
    maxStalenessMs: stats.maxStalenessMs,
    source: stats.source,
  };
}

async function statsOf(ctx: OpsContext, queue: string): Promise<TransportStats> {
  try {
    return await ctx.jobs!.transport.stats(queue);
  } catch (error) {
    // A broker that cannot answer is "unknown" for the page, not a failed page.
    ctx.logger.warn('transport stats failed', {
      queue,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return unavailable(ctx.clock.now());
  }
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    results.push(...(await Promise.all(items.slice(at, at + size).map(run))));
  }
  return results;
}

/** `GET /transport`: the broker's numbers per queue next to the store's view of the same queue. */
export function readTransport(ctx: OpsContext, fresh: boolean): Promise<TransportResponse> {
  return ctx.cache.get('transport', () => build(ctx, fresh), fresh);
}

async function build(ctx: OpsContext, fresh: boolean): Promise<TransportResponse> {
  const declared = ctx.deps.transport;
  const hasDeadLetter = declared.doorbellDeadLetter !== false;
  const scan = await scanDoorbells(ctx, fresh);
  const now = ctx.clock.now();
  const readings = await inBatches(scan.queues, STATS_CONCURRENCY, (queue) => statsOf(ctx, queue));
  const queues: TransportQueueStats[] = scan.queues.map((queue, index) => {
    const stats = readings[index]!;
    return {
      queue,
      doorbellDepth: stats.depth,
      inFlight: stats.inFlight,
      delayed: stats.delayed,
      oldestUndeliveredAgeMs: stats.oldestAgeMs,
      // A transport with no dead-letter queue has no depth to report: its "failed" jobs are the store's.
      deadLetterDepth: hasDeadLetter ? stats.deadLetterDepth : null,
      deadLetterOldestAgeMs: hasDeadLetter ? deadLetterOldestAgeMs(stats) : null,
      freshness: freshnessOf(stats, now),
      store: scan.rows.get(queue)!,
    };
  });
  return {
    ok: true,
    transport: {
      name: declared.name,
      maxDeliverDelayMs: Number.isFinite(declared.capabilities.maxDeliverDelayMs)
        ? declared.capabilities.maxDeliverDelayMs
        : null,
      ordering: declared.ordering ?? 'none',
      approximateCounts: declared.approximateCounts === true,
    },
    deadLetter: { supported: hasDeadLetter },
    queues,
    truncated: scan.truncated,
    timestamp: now,
  };
}
