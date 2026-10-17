import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import type { ServerLogLine } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { stripAnsi } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const STREAMS = ['all', 'stdout', 'stderr', 'sys'] as const;
type StreamFilter = (typeof STREAMS)[number];

const clock = (ts: number): string =>
  `${new Date(ts).toLocaleTimeString([], { hour12: false })}.${String(ts % 1000).padStart(3, '0')}`;

const toneFor = (stream: ServerLogLine['stream']): string =>
  stream === 'stderr' ? 'text-danger' : stream === 'sys' ? 'text-link' : 'text-muted';

export function downloadProcessLogs(content: string, timestamp = Date.now()): void {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `qelay-logs-${timestamp}.log`;
  try {
    // Firefox ignores programmatic clicks on detached download anchors.
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the blob alive through the browser's download dispatch task.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Live tail of the managed qelay process's stdout/stderr + agent system
 * messages, with stream filtering, text search, timestamps, a follow toggle,
 * and copy / download of exactly what's shown.
 */
export function ProcessLogs() {
  const { data, error, loading, refetch } = usePolledLogs();
  const lines = useMemo(() => data?.lines ?? [], [data]);

  const [stream, setStream] = useState<StreamFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [showTimes, setShowTimes] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    // qelay's banner writes ANSI color codes; rendered as text they're
    // "[1m…[0m" noise. Strip before filtering so search matches what's shown.
    return lines
      .map((l) => (l.line.includes('\u001b') ? { ...l, line: stripAnsi(l.line) } : l))
      .filter(
        (l) =>
          (stream === 'all' || l.stream === stream) &&
          (!term || l.line.toLowerCase().includes(term))
      );
  }, [lines, stream, search]);

  // Follow the tail only while enabled, so scrolling up to read isn't yanked back.
  // Follow the tail whenever new lines arrive.
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  const asText = useMemo(
    () =>
      shown.map((l) => (showTimes ? `${clock(l.ts)} [${l.stream}] ${l.line}` : l.line)).join('\n'),
    [shown, showTimes]
  );

  const download = () => {
    downloadProcessLogs(asText);
  };

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="mr-2 text-[15px] font-semibold tracking-tight text-fg">Process logs</h2>
        <SegmentedControl options={STREAMS} value={stream} onChange={setStream} />
        <div className="relative min-w-40 flex-1">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter log lines"
            name="process-log-filter"
            autoComplete="off"
            placeholder="Filter…"
            className="h-8 w-full rounded-control border border-line-strong bg-surface-2 pl-8 pr-2 text-xs text-fg placeholder:text-faint focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 light:bg-surface"
          />
        </div>
        <Toggle on={follow} onClick={() => setFollow((v) => !v)} label="Follow" />
        <Toggle on={showTimes} onClick={() => setShowTimes((v) => !v)} label="Times" />
        <CopyButton value={asText} />
        <Button size="sm" onClick={download} disabled={shown.length === 0}>
          Download
        </Button>
      </div>

      {error && data && (
        <div className="border-b border-line px-5 pt-3 font-sans">
          <OfflineBanner
            message={`Process-log refresh failed — showing the last received lines. ${error.message}`}
            onRetry={refetch}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        className="max-h-96 min-h-40 overflow-y-auto bg-bg p-5 font-mono text-xs leading-relaxed light:bg-surface-2"
      >
        {loading && !data && !error ? (
          <div className="font-sans">
            <LoadingState label="Loading process logs…" />
          </div>
        ) : error && !data ? (
          <div className="font-sans">
            <ErrorState error={error} onRetry={refetch} />
          </div>
        ) : shown.length === 0 ? (
          <p className="text-faint">
            {lines.length === 0 ? 'No output yet.' : 'No lines match the current filter.'}
          </p>
        ) : (
          shown.map((l) => (
            <div key={l.seq} className={cn('whitespace-pre-wrap', toneFor(l.stream))}>
              {showTimes && <span className="mr-2 text-faint">{clock(l.ts)}</span>}
              {l.line}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-[11px] text-faint">
        <span>
          {error && !data
            ? 'logs unavailable'
            : shown.length === lines.length
              ? `${lines.length} lines`
              : `${shown.length} of ${lines.length} lines`}
        </span>
        <span>{error ? 'refresh failed' : follow ? 'following tail' : 'paused'}</span>
      </div>
    </Card>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'h-8 rounded-control border px-2.5 text-xs transition-colors',
        on
          ? 'border-link/40 bg-selected text-link'
          : 'border-line bg-surface-2 text-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  );
}

// Local poll so the panel owns its own cadence without touching the page fetch.
function usePolledLogs() {
  return usePolledData(() => bq.control.logs(), []);
}
