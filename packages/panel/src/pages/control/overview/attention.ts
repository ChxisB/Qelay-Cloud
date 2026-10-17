import type { OverviewSnapshot } from './model';

export interface Attention {
  headline: string;
  detail: string;
  /** Where "Review" goes: the DLQ for dead-lettered jobs, the failed-jobs list otherwise. */
  reviewLabel: string;
  reviewTo: string;
}

const jobs = (n: number) => `${n} ${n === 1 ? 'job is' : 'jobs are'}`;

/**
 * The banner shows when the server reports dead-lettered jobs or any queue holds failed
 * jobs. No other signal counts: no thresholds, no rates. DLQ wins when both apply because
 * those jobs have stopped retrying and need a decision.
 */
export function attentionFor(
  s: Pick<OverviewSnapshot, 'overview' | 'dlqQueues' | 'failedTotal' | 'details'>
): Attention | null {
  const dlq = s.overview.stats.dlq;
  if (dlq > 0) {
    const holders = s.dlqQueues;
    const single = holders?.length === 1 ? holders[0] : null;
    return {
      headline: single
        ? `${jobs(dlq)} in the ${single.name} dead letter queue`
        : holders && holders.length > 1
          ? `${jobs(dlq)} in dead letter queues across ${holders.length} queues`
          : `${jobs(dlq)} in the dead letter queue`,
      detail: 'They stopped retrying and are waiting for a decision.',
      reviewLabel: 'Review DLQ',
      reviewTo: single ? `/dlq?queue=${encodeURIComponent(single.name)}` : '/dlq',
    };
  }
  if (s.failedTotal > 0) {
    const worst = s.details.find((q) => (q.counts?.failed ?? 0) > 0);
    return {
      headline: `${s.failedTotal} failed ${s.failedTotal === 1 ? 'job' : 'jobs'} recorded across your queues`,
      detail: 'Failed jobs stay on record until someone retries or removes them.',
      reviewLabel: 'Review failed jobs',
      reviewTo: worst
        ? `/jobs?queue=${encodeURIComponent(worst.name)}&status=failed`
        : '/jobs?status=failed',
    };
  }
  return null;
}
