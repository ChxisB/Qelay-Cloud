import { useState } from 'react';
import { bq, BqError, type WebhookIssueStatus } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';

/**
 * Moves an issue to another status. One at a time per issue; the list is read again once the server has answered,
 * and also when it says the issue is resolved or gone, because then the list on screen is out of date.
 */
export function useIssueActions(refetch: () => Promise<void>) {
  const guard = useServerActionGuard('webhook-issues');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setStatus = async (id: string, status: WebhookIssueStatus) => {
    const lease = guard.begin(['registry-write', `webhook-issue:${id}`]);
    if (!lease) return;
    setPending(id);
    setError(null);
    try {
      await bq.setWebhookIssueStatus(id, status);
      if (!lease.isCurrent()) return;
      await refetch();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setError((caught as Error).message);
      const stale =
        caught instanceof BqError &&
        (caught.code === 'issue_resolved' || caught.code === 'issue_not_found');
      if (stale) await refetch();
    } finally {
      if (lease.finish()) setPending(null);
    }
  };

  return { pending, error, setStatus };
}
