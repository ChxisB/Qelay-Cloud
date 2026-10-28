import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { bq, type RequestStatus } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { useRowArrivals } from '@/lib/useRowArrivals';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { GatewayPage } from './GatewayPage';
import { RequestDetail } from './RequestDetail';
import { RequestsTable } from './RequestsTable';
import { REQUEST_CHIPS, REQUESTS } from './sourceModel';

const PAGE_LIMIT = 100;

/** A filter at its default is left out of the address. */
function setFilter(params: URLSearchParams, key: string, value: string) {
  if (value === '' || value === 'all') params.delete(key);
  else params.set(key, value);
}

/**
 * Every request the sources took, newest first, with what became of each (accepted, or rejected and why).
 * Filters live in the address; the page walks back with Older. A request opens beside the list on a wide
 * window and under it on a narrow one.
 */
export function Requests() {
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? '';
  const asked = params.get('status');
  const status = asked === 'accepted' || asked === 'rejected' ? asked : 'all';
  // `before` cursors of the pages already walked past: the last one is the page on screen.
  const [trail, setTrail] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const before = trail.at(-1);
  const guard = useServerActionGuard('webhook-requests');

  const sources = usePolledData(() => bq.sources(), []);
  const routes = usePolledData(() => bq.webhooks(), []);
  const feed = usePolledData(
    () =>
      bq.requests({
        limit: PAGE_LIMIT,
        ...(before === undefined ? {} : { before }),
        ...(status === 'all' ? {} : { status: status as RequestStatus }),
        ...(source === '' ? {} : { source }),
      }),
    [source, status, before]
  );

  // A new connection is a new registry: nothing walked or open belongs to it.
  useEffect(() => {
    setTrail([]);
    setSelected(null);
  }, [guard.scopeKey]);

  const change = (key: 'source' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    setFilter(next, key, value);
    setParams(next, { replace: true });
    setTrail([]);
    setSelected(null);
  };

  const names = new Map((sources.data ?? []).map((one) => [one.id, one.name]));
  const byRoute = new Map((routes.data?.data?.webhooks ?? []).map((one) => [one.id, one]));
  const requests = feed.data?.requests ?? [];
  const next = feed.data?.next ?? null;
  const arrival = useRowArrivals(
    [source, status, before ?? ''].join('|'),
    requests.map((item) => item.id),
    !!feed.data
  );

  return (
    <GatewayPage current={REQUESTS} live={!!feed.data && !feed.error}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter requests by status" className="flex flex-wrap gap-2">
          {REQUEST_CHIPS.map((chip) => (
            <Button
              key={chip.value}
              size="sm"
              variant={status === chip.value ? 'primary' : 'default'}
              aria-pressed={status === chip.value}
              onClick={() => change('status', chip.value)}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        <span className="grow" />
        <div className="w-full sm:w-64">
          <Select
            aria-label="Source"
            value={source}
            onChange={(event) => change('source', event.target.value)}
          >
            <option value="">All sources</option>
            {(sources.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </div>
        <Button size="sm" onClick={() => void feed.refetch()}>
          Refresh
        </Button>
      </div>
      {feed.error && feed.data && (
        <OfflineBanner
          message="Request refresh failed — showing the last successful page."
          onRetry={feed.refetch}
        />
      )}
      {feed.error && !feed.data ? (
        <ErrorState error={feed.error} onRetry={feed.refetch} />
      ) : feed.loading && !feed.data ? (
        <LoadingState label="Loading requests…" />
      ) : requests.length === 0 ? (
        <EmptyState
          title="No requests"
          hint="A request appears here when a sender posts to one of your sources, whether it was accepted or not. Clear a filter to see more."
        />
      ) : (
        <div
          className={
            selected ? 'grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]' : undefined
          }
        >
          <RequestsTable
            requests={requests}
            sources={names}
            selected={selected}
            arrival={arrival}
            onToggle={(id) => setSelected(id === selected ? null : id)}
          />
          {selected && (
            <div className="motion-arrive min-w-0">
              <RequestDetail
                key={selected}
                id={selected}
                routes={byRoute}
                sources={names}
                onClose={() => setSelected(null)}
              />
            </div>
          )}
        </div>
      )}
      {(trail.length > 0 || next !== null) && (
        <div className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            disabled={trail.length === 0}
            onClick={() => setTrail((current) => current.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            size="sm"
            disabled={next === null}
            onClick={() => next !== null && setTrail((current) => [...current, next])}
          >
            Older
          </Button>
        </div>
      )}
    </GatewayPage>
  );
}
