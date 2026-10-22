import type { WebhookGroupStatFull } from '@/lib/bq';
import { formatNumber } from '@/lib/format';

/** A bar per hour, red where something failed. Decorative: the words beside it carry the figures. */
export function TrendBars({ stat, className }: { stat: WebhookGroupStatFull; className?: string }) {
  const tallest = Math.max(...stat.buckets.map((b) => b.delivered + b.failed + b.pending), 1);
  return (
    <span aria-hidden="true" className={`flex items-end gap-px ${className ?? 'h-6 w-24'}`}>
      {stat.buckets.map((bucket) => {
        const size = bucket.delivered + bucket.failed + bucket.pending;
        return (
          <span
            key={bucket.from}
            className={`min-w-px flex-1 rounded-[1px] ${bucket.failed > 0 ? 'bg-danger' : 'bg-muted/50'}`}
            style={{ height: size === 0 ? 0 : `${Math.max(12, (size / tallest) * 100)}%` }}
          />
        );
      })}
    </span>
  );
}

/** The last 24 hours of one connection: the bars and the share that failed. */
export function ConnectionTrend({ stat }: { stat: WebhookGroupStatFull | undefined }) {
  const total = stat ? stat.delivered + stat.failed + stat.pending : 0;
  if (!stat || total === 0) return <span className="text-[13px] text-muted">No events</span>;
  const failed = stat.failureRatio === null ? null : Math.round(stat.failureRatio * 1000) / 10;
  return (
    <div
      className="flex items-center gap-3"
      role="img"
      aria-label={`${formatNumber(stat.delivered)} successful, ${formatNumber(stat.failed)} failed, ${formatNumber(stat.pending)} waiting now in the last 24 hours`}
    >
      <TrendBars stat={stat} />
      <span className="text-[13px] tnum text-muted">
        <span className={stat.failed > 0 ? 'font-bold text-danger' : ''}>
          {failed === null ? '—' : `${failed}% failed`}
        </span>
        <span className="block">{formatNumber(total)} events</span>
      </span>
    </div>
  );
}
