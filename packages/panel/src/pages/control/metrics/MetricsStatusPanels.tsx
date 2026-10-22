import { Card, CardHeader } from '@/components/ui/Card';
import { Meter } from '@/components/ui/charts/HBars';
import { cn } from '@/lib/cn';
import { formatCompact, formatNumber, formatPercent, formatUptime } from '@/lib/format';
import { useChangeFlash } from '@/lib/useChangeFlash';
import type { useThroughputSeries } from '@/lib/useThroughputSeries';

export function MetricsStatusPanels({
  rate,
  stats,
}: {
  rate: number | null;
  stats: NonNullable<ReturnType<typeof useThroughputSeries>['latest']>['stats'] | undefined;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Error rate" sub="Failed jobs as a share of all processed jobs" />
        <div className="mb-5 flex items-center justify-around">
          <Rate
            value={rate == null ? '—' : formatPercent(rate)}
            label="error rate"
            danger={rate != null && rate > 0.05}
          />
          <Rate
            value={rate == null ? '—' : formatPercent(1 - rate)}
            label="success rate"
            success={rate != null}
          />
        </div>
        <Meter value={rate == null ? 0 : (1 - rate) * 100} tone="ok" label="Success rate" />
      </Card>
      <Card>
        <CardHeader title="Server overview" sub="Server-wide counts right now" />
        <dl className="divide-y divide-line text-[13px]">
          <ServerRow
            color="bg-state-waiting-fg"
            label="Standard waiting"
            value={stats ? formatNumber(stats.waiting) : '—'}
          />
          <ServerRow
            color="bg-state-active-fg"
            label="Processing"
            value={stats ? formatNumber(stats.active) : '—'}
          />
          <ServerRow
            color="bg-warning"
            label="Delayed"
            value={stats ? formatNumber(stats.delayed) : '—'}
          />
          <ServerRow
            color="bg-danger-fill"
            label="Dead Letter"
            value={stats ? formatNumber(stats.dlq) : '—'}
          />
          <ServerRow
            color="bg-state-waiting-fg"
            label="Pushed (since restart)"
            value={stats ? formatCompact(stats.totalPushed) : '—'}
          />
          <ServerRow
            color="bg-state-waiting-fg"
            label="Pulled (since restart)"
            value={stats ? formatCompact(stats.totalPulled) : '—'}
          />
          <ServerRow
            color="bg-success"
            label="Uptime"
            value={stats ? formatUptime(stats.uptime / 1000) : '—'}
            steady
          />
        </dl>
      </Card>
    </div>
  );
}

function Rate({
  value,
  label,
  danger,
  success,
}: {
  value: string;
  label: string;
  danger?: boolean;
  success?: boolean;
}) {
  const flash = useChangeFlash(value);
  return (
    <div className="text-center">
      <div
        className={cn(
          'text-[22px] leading-none font-semibold tracking-[-0.02em] tnum',
          danger ? 'text-danger' : success ? 'text-success' : 'text-fg'
        )}
      >
        <span key={flash} className={flash > 0 ? 'motion-flash' : undefined}>
          {value}
        </span>
      </div>
      <div className="mt-1.5 text-[13px] font-bold text-muted">{label}</div>
    </div>
  );
}

/** `steady` is for a figure that moves on every poll (uptime): it never washes. */
function ServerRow({
  color,
  label,
  value,
  steady,
}: {
  color: string;
  label: string;
  value: string;
  steady?: boolean;
}) {
  const flash = useChangeFlash(value);
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="flex items-center gap-2 text-muted">
        <span className={cn('size-2 rounded-full', color)} />
        {label}
      </dt>
      <dd className="font-bold tnum text-fg">
        <span key={flash} className={!steady && flash > 0 ? 'motion-flash' : undefined}>
          {value}
        </span>
      </dd>
    </div>
  );
}
