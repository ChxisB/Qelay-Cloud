import { useEffect, useMemo, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { LogBar, LogBox, LogChip, LogSearch } from '@/components/ui/LogViewer';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { formatNumber } from '@/lib/format';
import type { ActivityEvent } from '@/lib/types';
import { useActivityStream } from '@/lib/useActivityStream';
import { useFreshAfter } from '@/lib/useFreshAfter';
import { usePolledData } from '@/lib/usePolledData';
import { LogsEventList } from './logs/LogsEventList';
import { SelectedEvent } from './logs/SelectedEvent';
import { loadAllQueuePages } from './queue/queueDiscovery';

const ALL = '__all__';
const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];
// Mirrors MAX_EVENTS in useActivityStream — the ring buffer search/filters run over.
const BUFFER_SIZE = 250;

export function LogsPro() {
  const [queue, setQueue] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  // Which line is open below the viewer, and on which stream: a reconnect restarts `seq`.
  const [picked, setPicked] = useState<{ seq: number; target: string } | null>(null);
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

  const term = search.trim().toLowerCase();
  const source = frozen ?? events;
  // From the unfiltered list, so a filter or a search never makes old lines slide in; a paused view has none new.
  const freshAfter = useFreshAfter(source[0]?.seq);
  const filtered = useMemo(
    () =>
      source.filter((e) => {
        if (status !== 'all' && e.status !== status) return false;
        if (!term) return true;
        return (
          (e.jobId ?? '').toLowerCase().includes(term) ||
          (e.queue ?? '').toLowerCase().includes(term)
        );
      }),
    [source, status, term]
  );
  const statusCount = (s: StatusFilter) =>
    s === 'all' ? source.length : source.filter((e) => e.status === s).length;
  const selected =
    picked?.target === streamTarget ? (source.find((e) => e.seq === picked.seq) ?? null) : null;

  // Events that arrived since pause. seq is monotonic per stream, so the head
  // delta survives the ring buffer dropping old entries; clamped because a
  // reconnect resets seq to 0.
  const newSincePause = paused ? Math.max(0, (events[0]?.seq ?? 0) - (frozen[0]?.seq ?? 0)) : 0;

  // Any queue/server/credential switch tears the stream down. A paused snapshot
  // from the old target must not survive and render under the new connection.
  // streamTarget is the explicit lifecycle identity.
  useEffect(() => setFrozen(null), [streamTarget]);

  const emptyText = streamError
    ? `Event stream unavailable — ${streamError.message}. Retrying…`
    : !connected
      ? 'Connecting to the event stream…'
      : events.length > 0
        ? 'No events match the current filters.'
        : 'Waiting for activity…';

  return (
    <div>
      <PageHeader
        title="Activity logs"
        description="Every job event as it happens. Search by job ID or queue, filter by status, then select a line for its full record."
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
        <StatCard label="Total events" value={formatNumber(counters.total)} compact />
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
            <option value={ALL}>All queues</option>
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
              </option>
            ))}
          </Select>
        </div>
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
      </div>

      <LogBox>
        <LogBar>
          <LogSearch
            aria-label="Search by job ID or queue"
            name="activity-search"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by job ID or queue…"
          />
          {term && (
            <span role="status" className="text-[13px] font-semibold text-log-dim">
              {formatNumber(filtered.length)} {filtered.length === 1 ? 'match' : 'matches'}
            </span>
          )}
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
            {STATUS.map((s) => (
              <LogChip
                key={s}
                pressed={status === s}
                count={statusCount(s)}
                onClick={() => setStatus(s)}
                className="capitalize"
              >
                {s}
              </LogChip>
            ))}
          </div>
        </LogBar>
        <LogsEventList
          rows={filtered}
          term={term}
          selectedSeq={selected?.seq ?? null}
          onSelect={(seq) => setPicked({ seq, target: streamTarget })}
          empty={emptyText}
          total={source.length}
          bufferSize={BUFFER_SIZE}
          freshAfter={freshAfter}
        />
      </LogBox>

      {selected && <SelectedEvent event={selected} onClose={() => setPicked(null)} />}
    </div>
  );
}
