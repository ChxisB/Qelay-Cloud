import { useSearchParams } from 'react-router-dom';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { WebhookDrawing } from '@/components/ui/illustrations';
import { LinkButton } from '@/components/ui/LinkButton';
import { bq } from '@/lib/bq';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { usePolledData } from '@/lib/usePolledData';
import { ConnectionDiagram } from './ConnectionDiagram';
import { ConnectionDiagramRow } from './ConnectionDiagramRow';
import { ConnectionRow } from './ConnectionRow';
import { ConnectionsTable } from './ConnectionsTable';
import { ConnectionsToolbar, type View, VIEWS } from './ConnectionsToolbar';
import { ConnectionTrend } from './ConnectionTrend';
import { GatewayPage } from './GatewayPage';
import { filterRoutes, groupBySource, NEW_CONNECTION, STATE_FILTERS } from './model';
import { useGroupStats } from './useGatewayStats';
import { useRouteActions } from './useRouteActions';

/** The connections of the namespace, under the source each one listens to. */
export function Connections() {
  const { data, error, loading, refetch } = usePolledData(() => bq.webhooks(), []);
  const routes = data?.data?.webhooks ?? [];
  // One read for every row. Without it (an older server, or not yet) the column is left out.
  const groups = useGroupStats().data;
  const byRoute = groups && new Map(groups.groups.map((group) => [group.webhookId, group]));
  const { actErr, removing, testing, optimistic, remove, test, toggleEnabled } =
    useRouteActions(refetch);
  // Only the connections that come with the first load rise in turn; one a poll adds later just appears.
  const first = useFirstLoad(!!data);
  // The view and both filters live in the address, so a list can be bookmarked and survives a reload.
  const [params, setParams] = useSearchParams();
  const asked = VIEWS.find((item) => item.toLowerCase() === params.get('view'));
  const view: View = asked ?? 'Structured';
  const text = params.get('q') ?? '';
  const state = STATE_FILTERS.some((item) => item.value === params.get('state'))
    ? (params.get('state') as string)
    : 'all';
  const shown = filterRoutes(routes, { text, state });

  const change = (key: 'view' | 'q' | 'state', value: string) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === 'all' || (key === 'view' && value === 'Structured')) {
      next.delete(key);
    } else next.set(key, key === 'view' ? value.toLowerCase() : value);
    setParams(next, { replace: true });
  };

  const rowOf = (route: (typeof routes)[number], flat: boolean) => (
    <ConnectionRow
      key={route.id}
      route={route}
      flat={flat}
      enabled={optimistic[route.id]?.value ?? route.enabled}
      removing={removing.has(route.id)}
      testing={testing === route.id}
      trend={byRoute && <ConnectionTrend stat={byRoute.get(route.id)} />}
      onToggleEnabled={(next) => toggleEnabled(route.id, next)}
      onRemove={() => remove(route.id)}
      onTest={() => test(route.id)}
    />
  );

  const newConnection = (
    <LinkButton to={NEW_CONNECTION} variant="primary" size="sm">
      New connection
    </LinkButton>
  );

  return (
    <GatewayPage current="/events-gateway" live={!!data && !error} actions={newConnection}>
      {error && data && (
        <OfflineBanner
          message="Connection refresh failed — showing the last successful list."
          onRetry={refetch}
        />
      )}
      {actErr && (
        <div className="mb-6">
          <Banner tone="problem" title="The connection action did not go through">
            {actErr}
          </Banner>
        </div>
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading connections…" />
      ) : routes.length === 0 ? (
        <EmptyState
          picture={<WebhookDrawing />}
          title="No connections yet"
          hint="A connection sends the requests of an inbound source to an address of yours, or adds a job to a queue."
          action={newConnection}
        />
      ) : (
        <>
          <ConnectionsToolbar view={view} text={text} state={state} onChange={change} />
          {shown.length === 0 ? (
            <EmptyState
              title="No connection matches"
              hint="Nothing matches that text and state."
              action={
                <Button
                  size="sm"
                  onClick={() =>
                    setParams(new URLSearchParams(view === 'Table' ? { view: 'table' } : {}), {
                      replace: true,
                    })
                  }
                >
                  Clear filters
                </Button>
              }
            />
          ) : view === 'Table' ? (
            <ConnectionsTable
              routes={shown}
              row={(route) => rowOf(route, true)}
              trend={!!byRoute}
            />
          ) : (
            <ConnectionDiagram
              groups={groupBySource(shown)}
              row={(route, place, multi) => (
                <ConnectionDiagramRow
                  key={route.id}
                  route={route}
                  enabled={optimistic[route.id]?.value ?? route.enabled}
                  removing={removing.has(route.id)}
                  testing={testing === route.id}
                  stat={byRoute?.get(route.id)}
                  grouped={!!byRoute}
                  arrive={first ? place : undefined}
                  multi={multi}
                  onToggleEnabled={(next) => toggleEnabled(route.id, next)}
                  onRemove={() => remove(route.id)}
                  onTest={() => test(route.id)}
                />
              )}
            />
          )}
        </>
      )}
    </GatewayPage>
  );
}
