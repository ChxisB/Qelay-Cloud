import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { Legend } from '@/components/ui/charts/Legend';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { depthTrend, type useThroughputSeries } from '@/lib/useThroughputSeries';

const X_LABELS = ['-60s', '-45s', '-30s', '-15s', 'now'];

export function ThroughputCharts({ series }: { series: ReturnType<typeof useThroughputSeries> }) {
  const throughput = series.latest?.throughput;
  const trend = depthTrend(series.depth);
  const depthNow = series.depth.length ? series.depth[series.depth.length - 1] : null;
  const fallback = (title: string) =>
    series.error ? (
      <EmptyState title={`${title} unavailable`} hint={series.error.message} />
    ) : (
      <LoadingState label={`Connecting ${title.toLowerCase()}…`} />
    );
  return (
    <>
      <Card className="mb-6">
        <CardHeader
          title="Live throughput"
          sub="Jobs a second, rolling 60 second window"
          action={
            throughput && (
              <Legend
                items={[
                  {
                    tone: 'active',
                    label: 'Pushed',
                    value: `${throughput.pushPerSec.toFixed(1)}/s`,
                  },
                  {
                    tone: 'ok',
                    label: 'Completed',
                    value: `${throughput.completePerSec.toFixed(1)}/s`,
                  },
                  { tone: 'bad', label: 'Failed', value: `${throughput.failPerSec.toFixed(1)}/s` },
                ]}
              />
            )
          }
        />
        {!series.latest ? (
          fallback('Live throughput')
        ) : (
          <AreaChart
            xLabels={X_LABELS}
            series={[
              { label: 'Pushed', color: 'var(--state-active-fg)', points: series.push, area: true },
              { label: 'Completed', color: 'var(--state-completed-fg)', points: series.complete },
              { label: 'Failed', color: 'var(--state-failed-fg)', points: series.fail },
            ]}
          />
        )}
      </Card>
      <Card className="mb-6">
        <CardHeader
          title="Queue depth"
          sub="Every job not yet finished: waiting, prioritized, active, delayed and waiting-children. The trend says whether you are draining or falling behind."
          action={
            <div className="text-right">
              <div className="tnum text-[20px] leading-none font-bold text-fg">
                {depthNow == null ? '—' : formatNumber(depthNow)}
              </div>
              <div
                className={cn(
                  'mt-1 text-[13px] font-bold',
                  trend.label === 'draining'
                    ? 'text-success'
                    : trend.label === 'accumulating'
                      ? 'text-danger'
                      : 'text-muted'
                )}
              >
                {depthNow == null
                  ? 'unavailable'
                  : trend.label === 'steady'
                    ? 'steady'
                    : `${trend.slope > 0 ? '+' : ''}${trend.slope.toFixed(1)}/s · ${trend.label}`}
              </div>
            </div>
          }
        />
        {!series.latest ? (
          fallback('Queue depth')
        ) : (
          <AreaChart
            xLabels={X_LABELS}
            ariaLabel="queue depth chart"
            series={[
              {
                label: 'Depth',
                color: trend.draining ? 'var(--state-completed-fg)' : 'var(--state-delayed-fg)',
                points: series.depth,
                area: true,
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}
