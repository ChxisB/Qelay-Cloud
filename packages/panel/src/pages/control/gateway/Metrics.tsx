import { useSearchParams } from 'react-router-dom';
import { Select } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { GatewayPage } from './GatewayPage';
import { MetricsReport, RangeSelect, StatsFrame } from './MetricsParts';
import { routeLine } from './model';
import { useGatewayStats, useRange } from './useGatewayStats';

/** Deliveries by outcome, how long receivers took, and what is waiting now, for one connection or all. */
export function Metrics() {
  const [params, setParams] = useSearchParams();
  const route = params.get('route') ?? '';
  const [range, setRange] = useRange();
  const routes = usePolledData(() => bq.webhooks(), []);
  const result = useGatewayStats(route, range);

  const setRoute = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete('route');
    else next.set('route', value);
    setParams(next, { replace: true });
  };

  return (
    <GatewayPage current="/events-gateway/metrics" live={!!result.data && !result.error}>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Select
          aria-label="Connection"
          value={route}
          onChange={(event) => setRoute(event.target.value)}
        >
          <option value="">All connections</option>
          {(routes.data?.data?.webhooks ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {routeLine(item)}
            </option>
          ))}
        </Select>
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <StatsFrame result={result}>
        {(stats) => <MetricsReport stats={stats} route={route} range={range} />}
      </StatsFrame>
    </GatewayPage>
  );
}
