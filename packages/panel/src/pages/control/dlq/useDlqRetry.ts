import { useRef, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq } from '@/lib/bq';
import type { DlqEntryFull } from '@/lib/bqTypes';

export const RETRY_LIMIT = 500;
const REASONS = ['explicit_fail', 'max_attempts_exceeded', 'timeout', 'stalled'];

/**
 * Retrying failed jobs of one queue: a single entry with the version the page read, or up to RETRY_LIMIT after a
 * question. `retrying` is the job being retried, or '*' while a set is; one retry at a time keeps the "back in the
 * queue" counts honest. `done` runs after every attempt, whatever it ended in, to refresh the page.
 */
export function useDlqRetry(queue: string, reason: string, done: () => void) {
  const [retrying, setRetrying] = useState<string | null>(null);
  // State alone would let two clicks in one tick both start: the lease is taken before the first render.
  const leased = useRef(false);

  const retried = async (work: () => Promise<void>, id: string) => {
    if (leased.current) return;
    leased.current = true;
    setRetrying(id);
    try {
      await work();
    } catch (caught) {
      toast.error('Could not retry', (caught as Error).message);
    } finally {
      leased.current = false;
      setRetrying(null);
      done();
    }
  };

  const retryOne = (entry: DlqEntryFull) =>
    retried(async () => {
      await bq.retryDlq(queue, entry.job.id, entry.job.version);
      toast.success('Job is back in the queue', entry.job.id);
    }, entry.job.id);

  const retryAll = async () => {
    // The server filters by the reason itself; a reason it does not know (an older name) is not sent.
    const only = REASONS.includes(reason) ? reason : undefined;
    const yes = await confirmInPage({
      question: `Put up to ${RETRY_LIMIT} failed jobs of "${queue}" back in the queue?`,
      confirmLabel: 'Retry jobs',
      detail: `The oldest failures go first${only ? `, only those that failed with ${only}` : ''}. Each job starts again with all its attempts. Jobs that belong to a flow stay here.`,
    });
    if (!yes) return;
    await retried(async () => {
      const result = await bq.retryDlqMany(queue, {
        limit: RETRY_LIMIT,
        ...(only ? { reason: only } : {}),
      });
      toast.success(
        `${result.count} ${result.count === 1 ? 'job is' : 'jobs are'} back in the queue`,
        result.remaining > 0
          ? `${result.remaining} more can be retried: press the button again.`
          : undefined
      );
    }, '*');
  };

  return { retrying, retryOne, retryAll };
}
