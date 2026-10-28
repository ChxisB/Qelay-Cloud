import { useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { bq, BqError } from '@/lib/bq';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { usePolledData } from '@/lib/usePolledData';
import { usePresence } from '@/lib/usePresence';
import { useRowArrivals } from '@/lib/useRowArrivals';
import { GatewayPage } from './GatewayPage';
import { SourceCard } from './SourceCard';
import { SourceForm } from './SourceForm';
import { SourceIssuedBanner } from './SourceIssuedBanner';
import { type Issued, issuedOf, SOURCES } from './sourceModel';
import { useSourceActions } from './useSourceActions';

/** A server from before inbound sources answers the route with a not-found or not-allowed. */
const predatesSources = (error: Error | null) =>
  error instanceof BqError && (error.status === 404 || error.status === 405);

/**
 * Inbound sources: each is an address that senders post to, with the check a request must pass. A viewer reads
 * the list; an operator adds, turns off, re-keys and removes. What a create or a rotation makes (the address
 * and the secret) is shown once, in this page's state, until Done.
 */
export function Sources() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(() => bq.sources(), []);
  const [issued, setIssued] = useState<Issued | null>(null);
  const actions = useSourceActions(refetch, (made) => setIssued(issuedOf(made)));
  const [adding, setAdding] = useState(false);
  const form = usePresence(adding);
  const older = !data && predatesSources(error);
  const arrival = useRowArrivals('sources', data?.map((source) => source.id) ?? [], !!data);

  return (
    <GatewayPage
      current={SOURCES}
      live={!!data && !error}
      actions={
        canOperate && data && !adding ? (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add source
          </Button>
        ) : undefined
      }
    >
      {error && data && (
        <OfflineBanner
          message="Source refresh failed — showing the last successful list."
          onRetry={refetch}
        />
      )}
      {issued && (
        <div className="mb-6">
          <SourceIssuedBanner issued={issued} onDone={() => setIssued(null)} />
        </div>
      )}
      {actions.error && (
        <div className="mb-6">
          <Banner tone="problem" title={`"${actions.error.name}" was not changed`}>
            {actions.error.msg}
          </Banner>
        </div>
      )}
      {form.mounted && (
        <div
          inert={form.leaving || undefined}
          className={cn('mb-4', form.leaving ? 'motion-leave' : 'motion-arrive')}
        >
          <Card>
            <CardHeader title="New source" headingLevel={3} />
            <SourceForm
              refetch={refetch}
              onIssued={(made) => setIssued(issuedOf(made))}
              onDone={() => setAdding(false)}
            />
          </Card>
        </div>
      )}
      {older ? (
        <EmptyState
          title="Sources are not available"
          hint="This server takes no requests from outside. Connections still listen to the sources it has."
        />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading sources…" />
      ) : data && data.length === 0 && !form.mounted ? (
        <EmptyState
          title="No sources yet"
          hint="Add a source to get an address that a sender posts to. Whatever it sends is stored, and each connection made from the source forwards it."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data?.map((source, index) => (
            <SourceCard
              key={source.id}
              source={source}
              canOperate={canOperate}
              busy={actions.pending === source.id}
              arrive={arrival(source.id, index)}
              actions={{
                toggle: () => void actions.toggle(source),
                rotateSecret: () => void actions.rotateSecret(source),
                rotateAddress: () => void actions.rotateAddress(source),
                remove: () => void actions.remove(source),
              }}
            />
          ))}
        </ul>
      )}
    </GatewayPage>
  );
}
