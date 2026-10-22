import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkTabs } from '@/components/ui/LinkTabs';
import { bq } from '@/lib/bq';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { usePolledData } from '@/lib/usePolledData';
import { ConnectionMetrics } from './ConnectionMetrics';
import { ConnectionOverview } from './ConnectionOverview';
import { ConnectionSettings } from './ConnectionSettings';
import { GatewayPage } from './GatewayPage';
import {
  connectionLink,
  destinationLabel,
  eventsLink,
  routeName,
  routeState,
  sourceLabel,
} from './model';
import { RouteStatePill } from './RouteStatePill';
import { useRouteActions } from './useRouteActions';

/** One connection: where it sends, how it is doing, and the pause, test and numbers that belong to it. */
export function ConnectionPage({ tab }: { tab: 'overview' | 'metrics' | 'settings' }) {
  const { id = '' } = useParams();
  const { data, error, loading, refetch } = usePolledData(() => bq.webhooks(), []);
  const navigate = useNavigate();
  const { actErr, optimistic, removing, remove, testing, test, toggleEnabled } =
    useRouteActions(refetch);
  const route = data?.data?.webhooks.find((item) => item.id === id);
  const operator = useCanOperate();
  const switched = route ? optimistic[route.id] : undefined;
  const enabled = route ? (switched?.value ?? route.enabled) : false;
  const state = route ? routeState(route, enabled, switched?.mode) : 'off';
  const base = connectionLink(id);

  return (
    <GatewayPage current="/events-gateway" live={!!data && !error}>
      {error && data && (
        <OfflineBanner
          message="Connection refresh failed — showing the last successful read."
          onRetry={refetch}
        />
      )}
      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading connection…" />
      ) : !route ? (
        <EmptyState
          title="This connection no longer exists"
          hint="It was removed, or the address is wrong. The list shows the connections there are now."
          action={<LinkButton to="/events-gateway">Back to connections</LinkButton>}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted">
                <Link to="/events-gateway" className="hover:underline">
                  Connections
                </Link>
                <span aria-hidden="true"> / </span>
                {sourceLabel(route)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2
                  className={`min-w-0 break-all text-lg font-semibold text-fg ${route.name ? '' : 'font-mono'}`}
                >
                  {routeName(route)}
                </h2>
                <RouteStatePill state={state} />
              </div>
              {route.name && (
                <p className="m-0 mt-1 break-all font-mono text-[13px] text-muted">
                  {destinationLabel(route)}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LinkButton size="sm" to={eventsLink({ route: route.id })}>
                View events
              </LinkButton>
              {operator && (
                <>
                  <Button
                    size="sm"
                    disabled={!enabled || testing === route.id}
                    title={enabled ? undefined : 'Resume the connection to send a test event'}
                    onClick={() => test(route.id)}
                  >
                    Send test event
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      enabled
                        ? toggleEnabled(route.id, false, 'hold')
                        : toggleEnabled(route.id, true)
                    }
                  >
                    {enabled
                      ? 'Pause connection'
                      : state === 'off'
                        ? 'Enable connection'
                        : 'Resume connection'}
                  </Button>
                </>
              )}
            </div>
          </div>
          {state === 'paused' && route.disabledReason && (
            <div className="mb-4">
              <Banner tone="warn" title="Paused after failures">
                {route.disabledReason}
              </Banner>
            </div>
          )}
          {state === 'held' && (
            <div className="mb-4">
              <Banner tone="info" title="Paused">
                Events are being collected. Resume sends what was held.
              </Banner>
            </div>
          )}
          {actErr && (
            <div className="mb-4">
              <Banner title="Remove connection failed">{actErr}</Banner>
            </div>
          )}
          <LinkTabs
            label="This connection"
            tabs={[
              { to: base, label: 'Overview', current: tab === 'overview' },
              { to: `${base}/metrics`, label: 'Metrics', current: tab === 'metrics' },
              { to: `${base}/settings`, label: 'Settings', current: tab === 'settings' },
            ]}
          />
          <div key={tab} className="motion-arrive">
            {tab === 'overview' && <ConnectionOverview route={route} state={state} />}
            {tab === 'metrics' && <ConnectionMetrics route={route} />}
            {tab === 'settings' && (
              <ConnectionSettings
                key={route.id}
                route={route}
                enabled={enabled}
                removing={removing.has(route.id)}
                onSet={(next, mode) => toggleEnabled(route.id, next, mode)}
                refetch={refetch}
                onRemove={() =>
                  void remove(route.id).then((gone) => gone && navigate('/events-gateway'))
                }
                onRotated={() => void refetch()}
              />
            )}
          </div>
        </>
      )}
    </GatewayPage>
  );
}
