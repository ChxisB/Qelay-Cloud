import type { WebhookFull } from '@/lib/bqTypes';
import { MetricsReport, RangeSelect, StatsFrame } from './MetricsParts';
import { useGatewayStats, useRange } from './useGatewayStats';

/** The Metrics screen for one connection: the same report and time range, without the connection select. */
export function ConnectionMetrics({ route }: { route: WebhookFull }) {
  const [range, setRange] = useRange();
  const result = useGatewayStats(route.id, range);
  return (
    <>
      <div className="mb-4 w-full sm:w-60">
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <StatsFrame result={result}>
        {(stats) => <MetricsReport stats={stats} route={route.id} range={range} />}
      </StatsFrame>
    </>
  );
}
