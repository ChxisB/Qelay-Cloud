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
import { DestinationCard } from './DestinationCard';
import { DestinationForm } from './DestinationForm';
import { GatewayPage } from './GatewayPage';
import { useDestinationRemove } from './useDestinationRemove';

const DESTINATIONS = '/events-gateway/destinations';

/** A server from before saved destinations answers the route with a not-found or not-allowed. */
const predatesDestinations = (error: Error | null) =>
  error instanceof BqError && (error.status === 404 || error.status === 405);

/**
 * Saved destinations: a name for an address, so many connections can send to it and one change moves them all.
 * A viewer reads the list; an operator adds, edits and removes. A destination that connections use is not removed.
 */
export function Destinations() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(() => bq.destinations(), []);
  const { pending, error: removal, remove } = useDestinationRemove(refetch);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const older = !data && predatesDestinations(error);
  const adding = usePresence(editing === 'new');
  const arrival = useRowArrivals(
    'destinations',
    data?.map((destination) => destination.id) ?? [],
    !!data
  );

  return (
    <GatewayPage
      current={DESTINATIONS}
      live={!!data && !error}
      actions={
        canOperate && data && editing === null ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add destination
          </Button>
        ) : undefined
      }
    >
      {error && data && (
        <OfflineBanner
          message="Destination refresh failed — showing the last successful list."
          onRetry={refetch}
        />
      )}
      {removal && (
        <div className="mb-6">
          <Banner tone="problem" title={`"${removal.name}" was not removed`}>
            {removal.msg}
          </Banner>
        </div>
      )}
      {adding.mounted && (
        <div
          inert={adding.leaving || undefined}
          className={cn('mb-4', adding.leaving ? 'motion-leave' : 'motion-arrive')}
        >
          <Card>
            <CardHeader title="New destination" headingLevel={3} />
            <DestinationForm refetch={refetch} onDone={() => setEditing(null)} />
          </Card>
        </div>
      )}
      {older ? (
        <EmptyState
          title="Saved destinations are not available"
          hint="This server keeps no saved destinations. Connections still take an address or a queue of their own."
        />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading destinations…" />
      ) : data && data.length === 0 && !adding.mounted ? (
        <EmptyState
          title="No saved destinations"
          hint="Save an address once, then make connections from it. Changing the address changes every connection made from it."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data?.map((destination, index) => (
            <DestinationCard
              key={destination.id}
              destination={destination}
              canOperate={canOperate}
              editing={editing === destination.id}
              busy={pending === destination.id}
              arrive={arrival(destination.id, index)}
              onEdit={() => setEditing(destination.id)}
              onRemove={() => void remove(destination.id, destination.name)}
              refetch={refetch}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}
    </GatewayPage>
  );
}
