import { bq } from '@/lib/bq';
import { loadAllQueuePages } from '../queue/queueDiscovery';
import { assertRenderableOverview, type OverviewSnapshot, type QueueHealth } from './model';

/** Rows the Queue health table shows; the rest are one click away on /queues. */
export const QUEUE_ROWS = 8;

const sum = <T>(items: readonly T[], pick: (item: T) => number): number =>
  items.reduce((total, item) => total + pick(item), 0);

/**
 * One poll of everything the Overview shows. /dashboard and /queues/summary are the
 * original two calls. /health (server version) and /dashboard/queues (per-queue DLQ
 * counts, one page request per 500 queues) are the two the redesigned page adds; both
 * are optional, so a failure there leaves the version and DLQ column blank instead of
 * turning the whole page into an error.
 */
export async function loadOverview(): Promise<OverviewSnapshot> {
  const [overview, summary, health, queuePages] = await Promise.all([
    bq.overview(),
    bq.queuesSummary(),
    bq.health().catch(() => null),
    loadAllQueuePages().catch(() => null),
  ]);
  // TypeScript types do not validate a 2xx body. Reject an incomplete snapshot before
  // render-time destructuring so usePolledData can expose an error (or keep the previous
  // good snapshot in degraded mode).
  assertRenderableOverview(overview);

  const dlqByQueue = queuePages ? new Map(queuePages.queues.map((q) => [q.name, q.dlq])) : null;
  const rows: QueueHealth[] = summary.map((q) => ({
    name: q.name,
    paused: q.paused,
    dlq: dlqByQueue ? (dlqByQueue.get(q.name) ?? 0) : null,
    counts: q.counts,
  }));
  // Worst first: dead-lettered, then failed, then the biggest ready backlog.
  rows.sort(
    (a, b) =>
      (b.dlq ?? 0) - (a.dlq ?? 0) ||
      (b.counts?.failed ?? 0) - (a.counts?.failed ?? 0) ||
      readyOf(b) - readyOf(a)
  );

  const counts = summary.map((q) => q.counts);
  const waitingTotal = sum(counts, (c) => c.waiting);
  const prioritizedTotal = sum(counts, (c) => c.prioritized);
  return {
    overview,
    queuesTotal: summary.length,
    details: rows.slice(0, QUEUE_ROWS),
    dlqQueues: queuePages
      ? queuePages.queues.filter((q) => q.dlq > 0).map((q) => ({ name: q.name, dlq: q.dlq }))
      : null,
    // Recorded jobs, unlike stats.totalFailed (a session counter that resets on restart).
    failedTotal: sum(counts, (c) => c.failed),
    readyTotal: waitingTotal + prioritizedTotal,
    waitingTotal,
    prioritizedTotal,
    delayedTotal: sum(counts, (c) => c.delayed),
    serverVersion: typeof health?.version === 'string' ? health.version : null,
    sampledAt: Date.now(),
  };
}

function readyOf(row: QueueHealth): number {
  return (row.counts?.waiting ?? 0) + (row.counts?.prioritized ?? 0);
}
