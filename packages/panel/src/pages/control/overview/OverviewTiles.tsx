import { StatCard } from '@/components/ui/StatCard';
import { formatCompact, formatNumber } from '@/lib/format';
import { type OverviewSnapshot, WAITING_AMBER_THRESHOLD } from './model';

/**
 * The six board tiles. A seventh, Failed, joins them only while recorded failures exist
 * (the attention tile), so a healthy server shows exactly the designed row.
 */
export function OverviewTiles({ snapshot: s }: { snapshot: OverviewSnapshot }) {
  const { stats, throughput } = s.overview;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-3">
      {s.failedTotal > 0 && (
        <StatCard
          label="Failed"
          value={formatNumber(s.failedTotal)}
          tone="red"
          hint="recorded across queues"
        />
      )}
      <StatCard
        label="Completed"
        value={formatNumber(stats.completed)}
        tone="green"
        hint={`${formatCompact(stats.totalPushed)} pushed since restart`}
      />
      <StatCard
        label="Active"
        value={formatNumber(stats.active)}
        tone="active"
        hint="in flight now"
      />
      <StatCard
        label="Ready backlog"
        value={formatNumber(s.readyTotal)}
        tone={s.readyTotal > WAITING_AMBER_THRESHOLD ? 'amber' : 'default'}
        hint={`${formatNumber(s.waitingTotal)} waiting · ${formatNumber(s.prioritizedTotal)} prioritized`}
      />
      <StatCard label="Delayed" value={formatNumber(s.delayedTotal)} hint="scheduled for later" />
      <StatCard label="Push / s" value={throughput.pushPerSec.toFixed(2)} hint="jobs per second" />
      <StatCard
        label="Pull / s"
        value={throughput.pullPerSec.toFixed(2)}
        tone="waiting"
        hint="jobs per second"
      />
    </div>
  );
}
