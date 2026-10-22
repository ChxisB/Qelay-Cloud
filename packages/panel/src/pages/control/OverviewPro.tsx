import { useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatBytes, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { AttentionList } from './home/AttentionList';
import { buildCards, HomeCards } from './home/HomeCards';
import { homeIssues } from './home/model';
import { useHomeFeeds } from './home/useHomeFeeds';
import { JobFlow } from './overview/JobFlow';
import { loadOverview } from './overview/loadOverview';
import { EMPTY_OVERVIEW } from './overview/model';
import { OverviewHeader } from './overview/OverviewHeader';
import { QueueHealthTable } from './overview/QueueHealthTable';
import { RecentActivity } from './overview/RecentActivity';
import { StatusStripView } from './overview/StatusStrip';
import { ThroughputCard } from './overview/ThroughputCard';
import { appendSample, gapLimitMs, type ThroughputPoint } from './overview/throughputHistory';

export { assertRenderableOverview } from './overview/model';

export function OverviewPro() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const refreshMs = useConnectionStore((s) => s.refreshMs);
  const connection = useConnectionStore((s) =>
    JSON.stringify([s.activeProfileId, s.baseUrl, s.token])
  );
  const [paused, setPaused] = useState(false);
  // Throughput history is built from this page's own polls (no extra requests) and is
  // tied to one connection: retargeting the server starts a fresh chart.
  const history = useRef<{ key: string; points: ThroughputPoint[] }>({ key: '', points: [] });

  const { data, error, loading, refetch } = usePolledData(
    async () => {
      const snapshot = await loadOverview();
      const { pushPerSec, pullPerSec } = snapshot.overview.throughput;
      if (history.current.key !== connection) history.current = { key: connection, points: [] };
      history.current.points = appendSample(
        history.current.points,
        { at: snapshot.sampledAt, push: pushPerSec, pull: pullPerSec },
        gapLimitMs(refreshMs)
      );
      return snapshot;
    },
    [],
    { paused }
  );

  const feeds = useHomeFeeds(paused);

  if (loading && !data && !error) return <LoadingState label="Loading home…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Home" description="Real-time system health is unavailable." />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const snapshot = data ?? EMPTY_OVERVIEW;
  const { stats, memory } = snapshot.overview;
  const { deployment, transport, gateway, gatewayOpen, breaches } = feeds;
  const issues = homeIssues({
    snapshot,
    deployment: deployment.data,
    transport: transport.data,
    routes: gateway.data?.routes ?? [],
    breaches,
  });
  const pending = (feed: { data: unknown; error: unknown; loading: boolean }) =>
    feed.loading && !feed.data && !feed.error;
  const unavailable = [
    ...(!deployment.data && deployment.error ? ['Health', 'Workers'] : []),
    ...(!transport.data && transport.error ? ['Job delivery'] : []),
    ...(gatewayOpen && !gateway.data && gateway.error ? ['Event gateway'] : []),
  ];
  // A truthy `error` means the latest poll failed; keep rendering the last known data.
  const degraded = !!error;

  const togglePause = () => {
    setPaused((was) => !was);
    // Resuming fetches right away instead of waiting out the interval.
    if (paused) void refetch();
  };

  return (
    <div className="flex flex-col gap-6">
      <OverviewHeader
        live={!!data && !error}
        paused={paused}
        degraded={degraded}
        updatedAt={snapshot.sampledAt}
        onTogglePause={togglePause}
        strip={{
          host: baseUrl === '/api' ? 'localhost:6790' : baseUrl.replace(/^https?:\/\//, ''),
          version: snapshot.serverVersion,
          // stats.uptime from /dashboard is milliseconds; formatUptime expects seconds.
          uptime: stats.uptime ? formatUptime(stats.uptime / 1000) : '—',
          ram: formatBytes(memory.rss * 1024 * 1024),
        }}
      />
      {error && (
        <OfflineBanner
          message="Connection lost — showing the last successful overview snapshot."
          onRetry={refetch}
        />
      )}
      <StatusStripView data={deployment.data} error={deployment.error} />
      <AttentionList
        issues={issues}
        settled={![deployment, transport, ...(gatewayOpen ? [gateway] : [])].some(pending)}
        unavailable={unavailable}
      />
      <HomeCards cards={buildCards(snapshot, feeds)} />
      <JobFlow snapshot={snapshot} />
      <div className="flex flex-wrap items-stretch gap-6">
        <ThroughputCard points={history.current.points} />
        <RecentActivity />
      </div>
      <QueueHealthTable rows={snapshot.details} total={snapshot.queuesTotal} />
    </div>
  );
}
