import { MAX_PAGE_SIZE } from '@qelay-cloud/store-postgres';
import type { DoorbellHealthRow } from '../opsTypes';
import type { OpsContext } from './context';

export interface DoorbellScan {
  /** Queues the answer covers: those with pending jobs first, then the rest by name, at most the cap. */
  readonly queues: readonly string[];
  readonly rows: ReadonlyMap<string, DoorbellHealthRow>;
  /** More queues exist than `queues` holds. */
  readonly truncated: boolean;
  /** Queues with pending jobs that fell outside the cap, so their doorbells were not read. */
  readonly pendingSkipped: number;
}

/**
 * Reads the queue list and, for each queue with pending jobs, how many of its claimable jobs have
 * no bell. A queue with nothing pending is "none claimable, none unrung" without a query: that is
 * known from its counts, not guessed. The answer is kept for `deployment.cacheMs`, and `/transport`
 * and `/deployment` share it, so a panel polling both costs one scan.
 */
export function scanDoorbells(ctx: OpsContext, fresh: boolean): Promise<DoorbellScan> {
  return ctx.cache.get('doorbell-scan', () => readScan(ctx), fresh);
}

async function readScan(ctx: OpsContext): Promise<DoorbellScan> {
  const { store } = ctx.jobs!;
  const cap = ctx.config.deployment.maxQueues;
  const page = await store.readModels.queueSummaries({ limit: MAX_PAGE_SIZE });
  const pending = (item: (typeof page.items)[number]) =>
    item.counts.waiting + item.counts.prioritized + item.counts.delayed > 0;
  const withWork = page.items.filter(pending);
  const idle = page.items.filter((item) => !pending(item));
  const chosen = [...withWork, ...idle].slice(0, cap);
  const toRead = chosen.filter(pending).map((item) => item.queue);
  const health = await store.deployment.doorbellHealth(toRead);
  const byQueue = new Map(health.map((row) => [row.queue, row]));
  const rows = new Map<string, DoorbellHealthRow>();
  for (const item of chosen) {
    const read = byQueue.get(item.queue);
    rows.set(
      item.queue,
      read ?? {
        queue: item.queue,
        claimable: 0,
        notRung: 0,
        reRingDue: 0,
        oldestNotRungAgeMs: null,
        paused: item.paused,
        capped: false,
      }
    );
  }
  return {
    queues: chosen.map((item) => item.queue),
    rows,
    truncated: page.next !== null || page.items.length > chosen.length,
    pendingSkipped: Math.max(0, withWork.length - toRead.length),
  };
}
