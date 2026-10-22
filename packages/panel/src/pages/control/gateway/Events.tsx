import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { bq } from '@/lib/bq';
import type { WebhookDeliveryFull, WebhookDeliveryStatus } from '@/lib/bq/types';
import { useMinWidth } from '@/lib/useMinWidth';
import { usePolledData } from '@/lib/usePolledData';
import { usePresence } from '@/lib/usePresence';
import { useRowArrivals } from '@/lib/useRowArrivals';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { EventDetail } from './EventDetail';
import { EventFilters, type EventFilterValues } from './EventFilters';
import { EventSheet, useSheetOwner } from './EventSheet';
import { EventsTable } from './EventsTable';
import { EventTimeline } from './EventTimeline';
import { GatewayPage } from './GatewayPage';
import { EVENT_CHIPS, matchesEvent, rangeMs } from './model';
import { SavedViews, type ViewFilters } from './SavedViews';
import { DEFAULT_RANGE, useGatewayStats } from './useGatewayStats';

const PAGE_LIMIT = 100;

/** From this width the event opens in a column beside the list; under it, in a sheet from the bottom edge. */
const SIDE_COLUMN_PX = 1280;

/** A filter at its default (all connections, any status, 24 hours) is left out of the address. */
function setFilter(params: URLSearchParams, key: string, value: string) {
  if (value === '' || value === 'all' || (key === 'range' && value === DEFAULT_RANGE)) {
    params.delete(key);
  } else params.set(key, value);
}

/** Every event of every connection, newest first, with what became of each. Filters live in the address. */
export function Events() {
  const [params, setParams] = useSearchParams();
  const route = params.get('route') ?? '';
  const asked = params.get('status');
  const status = EVENT_CHIPS.some((chip) => chip.value === asked) ? (asked ?? 'all') : 'all';
  const range = params.get('range') ?? DEFAULT_RANGE;
  const [local, setLocal] = useState({ code: '', text: '' });
  // `before` cursors of the pages already walked past: the last one is the page on screen.
  const [trail, setTrail] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const before = trail.at(-1);
  const guard = useServerActionGuard('webhook-events');

  const routes = usePolledData(() => bq.webhooks(), []);
  const feed = usePolledData(
    () =>
      bq.webhookEvents({
        limit: PAGE_LIMIT,
        since: Date.now() - rangeMs(range, DEFAULT_RANGE),
        ...(before === undefined ? {} : { before }),
        ...(status === 'all' ? {} : { status: status as WebhookDeliveryStatus }),
        ...(route === '' ? {} : { webhook: route }),
      }),
    [route, status, range, before]
  );
  // The strip is read when the filters change and on Refresh, not on every poll of the list.
  const strip = useGatewayStats(route, range, { paused: true });

  // A new connection is a new registry: nothing walked or open belongs to it.
  useEffect(() => {
    setBusy(false);
    setRefreshing(false);
    setTrail([]);
    setSelected(null);
  }, [guard.scopeKey]);

  const change = (key: keyof EventFilterValues, value: string) => {
    if (key === 'code' || key === 'text')
      return setLocal((current) => ({ ...current, [key]: value }));
    const next = new URLSearchParams(params);
    setFilter(next, key, value);
    setParams(next, { replace: true });
    setTrail([]);
    setSelected(null);
  };

  const applyView = (view: ViewFilters) => {
    const next = new URLSearchParams(params);
    for (const key of ['route', 'status', 'range'] as const) setFilter(next, key, view[key]);
    setParams(next, { replace: true });
    setTrail([]);
    setSelected(null);
  };

  const refresh = async () => {
    const lease = guard.begin(['webhook-refresh', 'events']);
    if (!lease) return;
    setRefreshing(true);
    try {
      await Promise.all([feed.refetch(), strip.refetch()]);
    } finally {
      if (lease.finish()) setRefreshing(false);
    }
  };

  const run = async (key: string, action: () => Promise<unknown>, label: string) => {
    const lease = guard.begin(['webhook-delivery', key]);
    if (!lease) return;
    setBusy(true);
    try {
      assertSuccessfulMutationResponse(await action(), label);
      if (lease.isCurrent()) void feed.refetch();
    } catch (caught) {
      if (lease.isCurrent()) toast.error(`${label} failed`, (caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const retryAll = async () => {
    const yes = await confirmInPage({
      question: 'Retry every failed event of this connection (up to 500)?',
      confirmLabel: 'Retry all failed',
    });
    if (!yes) return;
    void run(
      `retry-all:${route}`,
      async () => {
        const answer = await bq.retryFailedWebhookDeliveries(route);
        const n = answer.data?.retried ?? 0;
        toast.success(
          'Retry queued',
          n === 0
            ? 'No failed events were left to retry.'
            : `${n} failed ${n === 1 ? 'event is' : 'events are'} back in line to be sent.`
        );
        return answer;
      },
      'Retry all failed'
    );
  };

  const byId = new Map((routes.data?.data?.webhooks ?? []).map((item) => [item.id, item]));
  const deliveries = (feed.data?.data.deliveries ?? []).filter((item) => matchesEvent(item, local));
  const next = feed.data?.data.next ?? null;
  const open = deliveries.find((item) => item.id === selected);
  const arrival = useRowArrivals(
    [route, status, range, before ?? ''].join('|'),
    (feed.data?.data.deliveries ?? []).map((item) => item.id),
    !!feed.data
  );
  const sheet = !useMinWidth(SIDE_COLUMN_PX) && open !== undefined;
  const sheetPresence = usePresence(sheet);
  // The sheet keeps the last event it showed while it leaves, so its content does not vanish mid-exit.
  const [shown, setShown] = useState<WebhookDeliveryFull>();
  if (open && open !== shown) setShown(open);
  const closeEvent = useCallback(() => setSelected(null), []);
  useSheetOwner(sheet, closeEvent);
  const detailFor = (delivery: WebhookDeliveryFull) => (
    <EventDetail
      delivery={delivery}
      route={byId.get(delivery.webhookId)}
      busy={busy}
      onClose={closeEvent}
      onRetry={() =>
        run(
          `retry:${delivery.id}`,
          () => bq.retryWebhookDelivery(delivery.webhookId, delivery.id),
          'Retry event'
        )
      }
    />
  );

  return (
    <GatewayPage current="/events-gateway/events" live={!!feed.data && !feed.error}>
      <EventFilters
        values={{ route, status, range, ...local }}
        routes={routes.data?.data?.webhooks ?? []}
        onChange={change}
        action={
          <>
            <SavedViews current={{ route, status, range }} onApply={applyView} />
            <Button size="sm" disabled={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={route === '' || !byId.has(route) || busy}
              title={route === '' ? 'Choose a connection to retry its failed events' : undefined}
              onClick={() => void retryAll()}
            >
              Retry all failed
            </Button>
          </>
        }
      />
      <EventTimeline result={strip} range={range} />
      {feed.error && feed.data && (
        <OfflineBanner
          message="Event refresh failed — showing the last successful page."
          onRetry={feed.refetch}
        />
      )}

      {feed.error && !feed.data ? (
        <ErrorState error={feed.error} onRetry={feed.refetch} />
      ) : feed.loading && !feed.data ? (
        <LoadingState label="Loading events…" />
      ) : deliveries.length === 0 ? (
        <EmptyState
          title="No events"
          hint="Events appear here when a job event matches a connection. Widen the time range or clear a filter to see more."
        />
      ) : (
        <div
          className={
            open && !sheet ? 'grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]' : ''
          }
        >
          <EventsTable
            deliveries={deliveries}
            routes={byId}
            selected={selected}
            arrival={arrival}
            onToggle={(id) => setSelected(id === selected ? null : id)}
          />
          {open && !sheet && <div className="motion-arrive min-w-0">{detailFor(open)}</div>}
        </div>
      )}

      {sheetPresence.mounted && shown && (
        <EventSheet leaving={sheetPresence.leaving} onClose={closeEvent}>
          {detailFor(shown)}
        </EventSheet>
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
