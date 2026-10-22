import { Card } from '@/components/ui/Card';
import { Legend } from '@/components/ui/charts/Legend';
import { FILL } from '@/components/ui/charts/tones';
import { formatNumber } from '@/lib/format';
import { axis } from './MetricsParts';
import type { useGatewayStats } from './useGatewayStats';

/**
 * When the events of the list's connection and range happened, one stacked bar for each slice of the stats
 * read. A bar is not a link: narrowing to one slice needs a time in the address, which does not exist yet.
 */
export function EventTimeline({
  result,
  range,
}: {
  result: ReturnType<typeof useGatewayStats>;
  range: string;
}) {
  const { data, error, loading } = result;
  const stats = data?.data.stats;
  const total = stats ? stats.delivered + stats.failed + stats.pending : 0;
  const tallest = Math.max(
    1,
    ...(stats?.buckets.map((bucket) => bucket.delivered + bucket.failed + bucket.pending) ?? [])
  );
  const height = (count: number) => ({
    height: `${(count / tallest) * 100}%`,
    minHeight: count > 0 ? 2 : 0,
  });

  return (
    <Card className="mb-4">
      {!stats ? (
        <p className="m-0 text-sm text-muted">
          {error && !loading ? 'Timeline unavailable.' : 'Loading timeline…'}
        </p>
      ) : total === 0 ? (
        <p className="m-0 text-sm text-muted">No events in this range.</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`Events over time: ${stats.delivered} successful, ${stats.failed} failed, ${stats.pending} pending`}
            className="flex h-16 items-stretch gap-px"
          >
            {stats.buckets.map((bucket) => (
              <div key={bucket.from} data-bucket className="flex min-w-0 flex-1 flex-col-reverse">
                <div className={FILL.ok} style={height(bucket.delivered)} />
                <div className={FILL.bad} style={height(bucket.failed)} />
                <div className={FILL.warn} style={height(bucket.pending)} />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="mt-1 flex justify-between text-xs text-muted">
            {axis(
              stats.buckets.map((bucket) => bucket.from),
              range === '7d'
            ).map((label, n) => (
              // oxlint-disable-next-line react/no-array-index-key -- five fixed slots; two labels can match
              <span key={n}>{label}</span>
            ))}
          </div>
          <div className="mt-2">
            <Legend
              items={[
                { tone: 'ok', label: 'Successful', value: formatNumber(stats.delivered) },
                { tone: 'bad', label: 'Failed', value: formatNumber(stats.failed) },
                { tone: 'warn', label: 'Pending', value: formatNumber(stats.pending) },
              ]}
            />
          </div>
        </>
      )}
    </Card>
  );
}
