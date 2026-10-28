import { useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { bq, BqError, type SourceFull, type SourceIssued } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';

/** A source that connections read from is refused with how many; say it in words, as the server's count is the news. */
function refusalWords(error: unknown): string {
  if (error instanceof BqError && error.code === 'source_in_use') {
    const count = error.details?.routes;
    if (typeof count === 'number') {
      return `${count} connection${count === 1 ? ' is' : 's are'} made from it. Remove or move ${count === 1 ? 'it' : 'them'} first.`;
    }
  }
  return (error as Error).message;
}

/**
 * What an operator does to a source from its card, one at a time: turn it on or off, make a new secret or a new
 * address (each asks first, and the answer holds what is shown once, which goes to `onIssued`), or remove it.
 * A refusal is kept for the page to show; nothing changes.
 */
export function useSourceActions(
  refetch: () => Promise<void>,
  onIssued: (issued: SourceIssued) => void
) {
  const guard = useServerActionGuard('webhook-sources');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; msg: string } | null>(null);

  const run = async (
    source: SourceFull,
    ask: { question: string; confirmLabel: string; danger?: boolean } | null,
    act: () => Promise<SourceIssued | void>
  ) => {
    if (ask && !(await confirmInPage(ask))) return;
    const lease = guard.begin(['registry-write', `webhook-source:${source.id}`]);
    if (!lease) return;
    setPending(source.id);
    setError(null);
    try {
      const issued = await act();
      if (!lease.isCurrent()) return;
      if (issued) onIssued(issued);
      await refetch();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setError({ name: source.name, msg: refusalWords(caught) });
      // Gone already is as good as removed: show the list as it is now.
      if (caught instanceof BqError && caught.code === 'source_not_found') await refetch();
    } finally {
      if (lease.finish()) setPending(null);
    }
  };

  return {
    pending,
    error,
    toggle: (source: SourceFull) =>
      run(source, null, async () => {
        await bq.updateSource(source.id, { enabled: !source.enabled });
      }),
    rotateSecret: (source: SourceFull) =>
      run(
        source,
        {
          question: `Make a new secret for "${source.name}"? The old one keeps working for a day, so the sender can switch over.`,
          confirmLabel: 'Make new secret',
        },
        () => bq.rotateSourceSecret(source.id)
      ),
    rotateAddress: (source: SourceFull) =>
      run(
        source,
        {
          question: `Make a new address for "${source.name}"? The old address stops working at once.`,
          confirmLabel: 'Make new address',
          danger: true,
        },
        () => bq.rotateSourceToken(source.id)
      ),
    remove: (source: SourceFull) =>
      run(
        source,
        {
          question: `Remove the source "${source.name}"? Its address stops working and its stored requests are deleted.`,
          confirmLabel: 'Remove source',
          danger: true,
        },
        async () => {
          await bq.removeSource(source.id);
        }
      ),
  };
}
