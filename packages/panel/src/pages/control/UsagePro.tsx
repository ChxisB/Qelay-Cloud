import { HealthTabs } from '@/components/HealthTabs';
import { Banner } from '@/components/ui/Banner';
import { Card, CardHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { Wash } from '@/components/ui/Wash';
import { bq } from '@/lib/bq';
import type { StorageStatusFlat } from '@/lib/bqTypes';
import {
  errorRate,
  formatBytes,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUptime,
} from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertRenderableOverview } from './overview/model';

// Defensive fallback for the render after a successful, validated poll. Initial
// failures return an ErrorState above rather than presenting these zeroes as facts.
const EMPTY = {
  overview: {
    stats: {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      dlq: 0,
      totalPushed: 0,
      totalPulled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      uptime: 0,
    },
    memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
    crons: { total: 0 },
  },
  storage: {} as StorageStatusFlat,
  failedTotal: 0,
};

export function UsagePro() {
  const { data, error, loading, refetch } = usePolledData(async () => {
    // /storage is the honest disk-health source ({ ok, data: { diskFull, … } });
    // the /dashboard storage blob does not carry it.
    const [overview, storage, summary] = await Promise.all([
      bq.overview(),
      bq.storage(),
      bq.queuesSummary(),
    ]);
    if (!storage?.data || typeof storage.data.diskFull !== 'boolean') {
      throw new Error('Storage status response is missing disk health data');
    }
    // Reject an incomplete /dashboard body here so usePolledData reports it
    // (or keeps the last good snapshot) instead of render-time destructuring
    // crashing. Usage also renders heap size, which the shared check omits.
    assertRenderableOverview(overview);
    if (!Number.isFinite(overview.memory.heapUsed)) {
      throw new Error('Malformed /dashboard response: memory.heapUsed is missing or non-numeric.');
    }
    // Failed jobs summed across queues — stats.totalFailed is a session counter
    // that zeroes on server restart, useless for a "cumulative usage" page.
    const failedTotal = summary.reduce((a, q) => a + (q.counts?.failed ?? 0), 0);
    return { overview, storage: storage.data, failedTotal };
  }, []);

  if (loading && !data && !error) return <LoadingState label="Loading usage…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Usage" description="Cumulative resource usage is unavailable." />
        <HealthTabs current="/usage" />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const d = data ?? EMPTY;
  const { stats, memory, crons } = d.overview;
  const { storage, failedTotal } = d;
  const rate = errorRate(stats.completed, failedTotal);
  // stats.uptime from /dashboard is milliseconds; formatUptime expects seconds.
  const uptime = stats.uptime ? formatUptime(stats.uptime / 1000) : '—';

  return (
    <div>
      <PageHeader
        title="Usage"
        description="Cumulative resource usage on the connected server."
        live={!!data && !error}
      />
      <HealthTabs current="/usage" />
      {error && (
        <OfflineBanner
          message="Usage refresh failed — showing the last successful snapshot."
          onRetry={refetch}
        />
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Completed" value={formatNumber(stats.completed)} tone="green" />
        <StatCard
          label="Failed"
          value={formatNumber(failedTotal)}
          tone={failedTotal ? 'red' : 'default'}
        />
        <StatCard label="Waiting" value={formatNumber(stats.waiting)} tone="waiting" />
        <StatCard label="Active" value={formatNumber(stats.active)} tone="active" />
        <StatCard
          label="Error rate"
          value={rate == null ? '—' : formatPercent(rate)}
          tone={rate == null ? 'default' : rate > 0.05 ? 'red' : 'green'}
        />
        <StatCard label="Uptime" value={uptime} steady />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Runtime" />
          <dl className="m-0 divide-y divide-line">
            <Row label="Jobs pushed (since restart)" value={formatNumber(stats.totalPushed)} />
            <Row label="Jobs pulled (since restart)" value={formatNumber(stats.totalPulled)} />
            <Row label="Heap used" value={formatBytes(memory.heapUsed * 1024 * 1024)} />
            <Row label="RSS" value={formatBytes(memory.rss * 1024 * 1024)} />
            <Row label="Cron jobs" value={String(crons.total)} />
          </dl>
        </Card>
        <Card>
          <CardHeader title="Storage" />
          {storage.diskFull ? (
            <Banner key="full" tone="problem" title="Disk full — writes suspended">
              {storage.error}
              {storage.error && storage.since != null && ' · '}
              {storage.since != null && `since ${formatRelativeTime(storage.since)}`}
            </Banner>
          ) : (
            <Banner key="ok" tone="ok" title="Healthy">
              Disk writes are being accepted.
            </Banner>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="m-0 text-[13px] font-semibold tnum text-fg">
        <Wash value={value} />
      </dd>
    </div>
  );
}
