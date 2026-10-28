import { useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { SourcePicker } from './SourcePicker';

/**
 * A connection from before inbound sources has none and is off (docs/event-gateway.md). An operator picks one
 * here; the connection stays off until it is enabled, so nothing is sent by surprise.
 */
export function NeedsSource({
  routeId,
  operator,
  refetch,
}: {
  routeId: string;
  operator: boolean;
  refetch: () => Promise<void>;
}) {
  const guard = useServerActionGuard(`webhook-source-pick:${routeId}`);
  const sources = usePolledData(() => bq.sources(), []).data ?? [];
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy || choice === '') return;
    const lease = guard.begin(['registry-write', `webhook:${routeId}`]);
    if (!lease) return;
    setBusy(true);
    setError(null);
    try {
      assertSuccessfulMutationResponse(
        await bq.updateWebhook(routeId, { source: choice }),
        'Choose source'
      );
      if (lease.isCurrent()) await refetch();
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <Banner tone="warn" title="This connection needs a source">
      It has no source, so it is off and sends nothing.
      {operator ? ' Choose one, then enable the connection.' : ' An operator can choose one.'}
      {operator && (
        <form
          className="mt-3 flex max-w-xl flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SourcePicker sources={sources} value={choice} onChange={setChoice} />
          {error && (
            <p role="alert" className="m-0 text-[13px] font-bold text-danger">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={busy || choice === ''}>
              {busy ? 'Saving…' : 'Use this source'}
            </Button>
          </div>
        </form>
      )}
    </Banner>
  );
}
