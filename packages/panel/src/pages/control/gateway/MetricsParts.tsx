import type { ReactNode } from 'react';
import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { Legend } from '@/components/ui/charts/Legend';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { LinkButton } from '@/components/ui/LinkButton';
import { StatCard } from '@/components/ui/StatCard';
import type { WebhookStatsFull } from '@/lib/bq';
import { formatMs, formatNumber, formatPercent, formatRelativeTime } from '@/lib/format';
import { EndStates } from './EndStates';
import { eventsLink, RANGES } from './model';
import type { useGatewayStats } from './useGatewayStats';

/** Five evenly spaced times for the chart's axis: clock times up to a day, dates beyond. */
export function axis(froms: readonly number[], days: boolean): string[] {
  const at = (n: number) =>
    froms[Math.min(froms.length - 1, Math.round((n * (froms.length - 1)) / 4))]!;
  return [0, 1, 2, 3, 4].map((n) =>
    days
      ? new Date(at(n)).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(at(n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

export function RangeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label="Time range"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {RANGES.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </Select>
  );
}

/** What a read of the numbers is while it has none to show: the failure, the wait, or an empty window, in words. */
export function StatsFrame({
  result,
  children,
}: {
  result: ReturnType<typeof useGatewayStats>;
  children: (stats: WebhookStatsFull) => ReactNode;
}) {
  const { data, error, loading, refetch } = result;
  const stats = data?.data.stats;
  const empty = !!stats && stats.delivered + stats.failed + stats.pending === 0;
  return (
    <>
      {error && data && (
        <OfflineBanner
          message="Metric refresh failed — showing the last successful numbers."
          onRetry={refetch}
        />
      )}
      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading metrics…" />
      ) : !stats || empty ? (
        <EmptyState
          title="No events in this window"
          hint="Numbers appear here once a job event matches a connection. Try a longer time range."
        />
      ) : (
        children(stats)
      )}
    </>
  );
}

export function StatCards({ stats }: { stats: WebhookStatsFull }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Successful" value={formatNumber(stats.delivered)} tone="green" />
      <StatCard
        label="Failed"
        value={formatNumber(stats.failed)}
        tone={stats.failed > 0 ? 'red' : 'default'}
      />
      <StatCard
        label="Failure rate"
        value={stats.failureRatio === null ? '—' : formatPercent(stats.failureRatio)}
        hint="of finished events"
      />
      <StatCard
        label="Attempts per event"
        value={stats.avgAttempts === null ? '—' : stats.avgAttempts.toFixed(2)}
      />
      <StatCard
        label="Waiting now"
        value={formatNumber(stats.backlog)}
        hint={
          stats.oldestPendingAt === null
            ? undefined
            : `oldest ${formatRelativeTime(stats.oldestPendingAt)}`
        }
      />
      <StatCard
        label="Receiver speed (p95)"
        value={stats.latency ? formatMs(stats.latency.p95Ms) : '—'}
        hint={stats.latency ? `average ${formatMs(stats.latency.avgMs)}` : 'no answers yet'}
      />
    </div>
  );
}

export function EventsChart({ stats, range }: { stats: WebhookStatsFull; range: string }) {
  const froms = stats.buckets.map((bucket) => bucket.from);
  return (
    <Card>
      <CardHeader title="Events over time" headingLevel={3} />
      <AreaChart
        ariaLabel="events over time"
        xLabels={axis(froms, range === '7d')}
        series={[
          {
            label: 'Successful',
            color: 'var(--state-completed-fg)',
            points: stats.buckets.map((bucket) => bucket.delivered),
            area: true,
          },
          {
            label: 'Failed',
            color: 'var(--state-failed-fg)',
            points: stats.buckets.map((bucket) => bucket.failed),
            dashed: true,
          },
        ]}
      />
      <div className="mt-3">
        <Legend
          items={[
            { tone: 'ok', label: 'Successful', value: formatNumber(stats.delivered) },
            { tone: 'bad', label: 'Failed', value: formatNumber(stats.failed) },
          ]}
        />
      </div>
    </Card>
  );
}

function SpeedChart({ stats, range }: { stats: WebhookStatsFull; range: string }) {
  const froms = stats.buckets.map((bucket) => bucket.from);
  const speed = stats.buckets.some((bucket) => bucket.p95LatencyMs !== null);
  return (
    <Card>
      <CardHeader
        title="Receiver speed"
        headingLevel={3}
        sub="Time to the receiver's answer, per slice."
      />
      {speed ? (
        <AreaChart
          ariaLabel="receiver speed"
          xLabels={axis(froms, range === '7d')}
          formatValue={formatMs}
          floor={10}
          series={[
            {
              label: 'p95',
              color: 'var(--state-delayed-fg)',
              points: stats.buckets.map((bucket) => bucket.p95LatencyMs ?? 0),
              area: true,
            },
            {
              label: 'Average',
              color: 'var(--state-active-fg)',
              points: stats.buckets.map((bucket) => bucket.avgLatencyMs ?? 0),
              dashed: true,
            },
          ]}
        />
      ) : (
        <EmptyState
          title="No receiver answered"
          hint="Speed is the time to an HTTP answer. A queue route, a refusal or a timeout has none."
        />
      )}
    </Card>
  );
}

/** The whole report: the numbers, the way to the events behind them, and the two charts. */
export function MetricsReport({
  stats,
  route,
  range,
}: {
  stats: WebhookStatsFull;
  route: string;
  range: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatCards stats={stats} />
      <div className="flex flex-wrap gap-2">
        <LinkButton size="sm" to={eventsLink({ route, range, status: 'failed' })}>
          View failed events
        </LinkButton>
        <LinkButton size="sm" to={eventsLink({ route, range })}>
          View all events
        </LinkButton>
      </div>
      <EndStates stats={stats} />
      <EventsChart stats={stats} range={range} />
      <SpeedChart stats={stats} range={range} />
    </div>
  );
}
