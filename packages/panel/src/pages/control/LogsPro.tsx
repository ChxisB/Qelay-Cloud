import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SearchField } from '@/components/ui/SearchField';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import type { ActivityEvent } from '@/lib/types';
import { useActivityStream } from '@/lib/useActivityStream';
import { usePolledData } from '@/lib/usePolledData';
import { loadAllQueuePages } from './QueueControl';

const ALL = '__all__';
const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];
const PAGE = 10;
// Mirrors MAX_EVENTS in useActivityStream — the ring buffer search/filters run over.
const BUFFER_SIZE = 250;

export function LogsPro() {
  const [queue, setQueue] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  // Follow/pause: non-null holds the snapshot of `events` taken when the user
  // paused — the visible list freezes while the stream keeps buffering behind it.
  const [frozen, setFrozen] = useState<ActivityEvent[] | null>(null);
  const paused = frozen !== null;
  const streamTarget = useConnectionStore((state) =>
    JSON.stringify([state.baseUrl, state.token, queue])
  );

  // Dropdown options only — slow-poll so it doesn't ride the live SSE cadence.
  const {
    data: qs,
    error: discoveryError,
    refetch: refetchQueues,
  } = usePolledData(loadAllQueuePages, [], {
    intervalMs: 30000,
  });
  const {
    events,
    counters,
    throughput,
    connected,
    error: streamError,
  } = useActivityStream(queue === ALL ? undefined : queue);

  const filtered = useMemo(() => {
    const source = frozen ?? events;
    const term = search.trim().toLowerCase();
    return source.filter((e) => {
      if (status !== 'all' && e.status !== status) return false;
      if (!term) return true;
      return (
        (e.jobId ?? '').toLowerCase().includes(term) || (e.queue ?? '').toLowerCase().includes(term)
      );
    });
  }, [events, frozen, status, search]);

  // Events that arrived since pause. seq is monotonic per stream, so the head
  // delta survives the ring buffer dropping old entries; clamped because a
  // reconnect resets seq to 0.
  const newSincePause = paused ? Math.max(0, (events[0]?.seq ?? 0) - (frozen[0]?.seq ?? 0)) : 0;

  // Reset to first page when filters change.
  // Reset the view whenever the active filters change.
  useEffect(() => setPage(0), [queue, status, search]);
  // Any queue/server/credential switch tears the stream down. A paused snapshot
  // from the old target must not survive and render under the new connection.
  // streamTarget is the explicit lifecycle identity.
  useEffect(() => setFrozen(null), [streamTarget]);

  const start = page * PAGE;
  const rows = filtered.slice(start, start + PAGE);

  return (
    <div>
      <PageHeader
        title="Activity Logs"
        description="Real-time job activity across all queues."
        live={connected && !paused}
      />
      {discoveryError && (
        <OfflineBanner
          onRetry={refetchQueues}
          message={`Could not discover queues — ${discoveryError.message}. The current stream can still be used.`}
        />
      )}
      {streamError && (
        <OfflineBanner message={`Event stream unavailable — ${streamError.message}. Retrying…`} />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total Events" value={formatNumber(counters.total)} compact />
        <StatCard label="Completed" value={formatNumber(counters.completed)} tone="green" compact />
        <StatCard
          label="Failed"
          value={formatNumber(counters.failed)}
          tone={counters.failed ? 'red' : 'default'}
          compact
        />
        <StatCard label="Waiting" value={formatNumber(counters.waiting)} tone="waiting" compact />
        <StatCard label="Active" value={formatNumber(counters.active)} tone="active" compact />
        <StatCard label="Throughput" value={`${throughput.toFixed(1)}/s`} compact />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select
            aria-label="Filter by queue"
            name="activity-queue-filter"
            autoComplete="off"
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
          >
            <option value={ALL}>All Queues</option>
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
              </option>
            ))}
          </Select>
        </div>
        <SegmentedControl options={STATUS} value={status} onChange={setStatus} />
        <Button
          size="sm"
          onClick={() => setFrozen(paused ? null : events)}
          title={
            paused
              ? 'Resume applying live events to the list'
              : 'Freeze the visible list while the stream keeps buffering'
          }
        >
          {paused
            ? `Resume${newSincePause ? ` — ${formatNumber(newSincePause)} new` : ''}`
            : 'Following · Pause'}
        </Button>
        <SearchField
          containerClassName="ml-auto min-w-56 flex-1 md:max-w-xs"
          aria-label="Search by job ID or queue"
          name="activity-search"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by job ID or queue…"
        />
      </div>
      <p className="-mt-2 mb-4 text-xs text-faint">
        Search and filters cover the last {BUFFER_SIZE} streamed events held in this browser.
      </p>

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Event</th>
              <th className="px-4 py-2.5 font-semibold">Queue</th>
              <th className="px-4 py-2.5 text-right font-semibold">Timestamp</th>
              <th className="px-4 py-2.5 text-right font-semibold">ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-faint">
                  {streamError
                    ? `Event stream unavailable — ${streamError.message}. Retrying…`
                    : !connected
                      ? 'Connecting to the event stream…'
                      : events.length > 0
                        ? 'No events match the current filters.'
                        : 'Waiting for activity…'}
                </td>
              </tr>
            ) : (
              rows.map((e) => (
                <tr
                  key={e.seq}
                  className="border-b border-line last:border-0 hover:bg-surface-2/40"
                >
                  <td className="px-4 py-2.5">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-fg">
                    {e.event}
                    {e.status === 'failed' && e.error && (
                      <div
                        className="mt-0.5 max-w-64 truncate text-[11px] text-danger"
                        title={e.error}
                      >
                        {e.error}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
                      {e.queue || '—'}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2.5 text-right text-faint"
                    title={new Date(e.timestamp).toISOString()}
                  >
                    {formatRelativeTime(e.timestamp)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-faint">
                    {e.jobId ? (
                      <span className="inline-flex items-center gap-1">
                        <Link
                          to={`/job?id=${encodeURIComponent(e.jobId)}`}
                          className="text-link hover:underline"
                        >
                          {e.jobId}
                        </Link>
                        <CopyButton value={e.jobId} />
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={PAGE}
        total={filtered.length}
        onPageChange={setPage}
        label="events"
      />
    </div>
  );
}
