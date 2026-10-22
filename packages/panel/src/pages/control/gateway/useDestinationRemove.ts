import { useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { bq, BqError } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';

/** A destination that connections use is refused with how many; say it in words, as the server's count is the news. */
function refusalWords(error: unknown): string {
  if (error instanceof BqError && error.code === 'destination_in_use') {
    const count = error.details?.connections;
    if (typeof count === 'number') {
      return `${count} connection${count === 1 ? ' is' : 's are'} made from it. Remove or move ${count === 1 ? 'it' : 'them'} first.`;
    }
  }
  return (error as Error).message;
}

/** Removes a destination after asking, one at a time. A refusal is kept for the page to show; nothing changes. */
export function useDestinationRemove(refetch: () => Promise<void>) {
  const guard = useServerActionGuard('webhook-destinations');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; msg: string } | null>(null);

  const remove = async (id: string, name: string) => {
    const ok = await confirmInPage({
      question: `Remove the destination "${name}"?`,
      confirmLabel: 'Remove destination',
      danger: true,
    });
    if (!ok) return;
    const lease = guard.begin(['registry-write', `webhook-destination:${id}`]);
    if (!lease) return;
    setPending(id);
    setError(null);
    try {
      await bq.removeDestination(id);
      if (!lease.isCurrent()) return;
      await refetch();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setError({ name, msg: refusalWords(caught) });
      // Gone already is as good as removed: show the list as it is now.
      if (caught instanceof BqError && caught.code === 'destination_not_found') await refetch();
    } finally {
      if (lease.finish()) setPending(null);
    }
  };

  return { pending, error, remove };
}
