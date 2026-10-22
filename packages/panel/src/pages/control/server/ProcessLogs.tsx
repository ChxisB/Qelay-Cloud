import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Input, SegmentedControl } from '@/components/ui/form';
import { LogLine, LogScroll } from '@/components/ui/LogViewer';
import { bq } from '@/lib/bq';
import type { ServerLogLine } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { stripAnsi } from '@/lib/format';
import { stagger } from '@/lib/stagger';
import { useFreshAfter } from '@/lib/useFreshAfter';
import { usePolledData } from '@/lib/usePolledData';

const STREAMS = ['all', 'stdout', 'stderr', 'sys'] as const;
type StreamFilter = (typeof STREAMS)[number];

const clock = (ts: number): string =>
  `${new Date(ts).toLocaleTimeString([], { hour12: false })}.${String(ts % 1000).padStart(3, '0')}`;

/** Lines that slide in at once; a burst bigger than this shows the last of them sliding and the rest already there. */
const MAX_ARRIVING = 8;

const levelFor = (stream: ServerLogLine['stream']) =>
  stream === 'stderr' ? 'error' : stream === 'sys' ? 'cmd' : 'info';

/** One line. Where it slides in is read once, when it appears: a later poll, a filter or Times must not replay it. */
function ProcessLine({
  line,
  showTime,
  arrive,
}: {
  line: ServerLogLine;
  showTime: boolean;
  arrive: number | undefined;
}) {
  const [place] = useState(arrive);
  return (
    <LogLine
      level={levelFor(line.stream)}
      wrap
      className={cn('pl-4', place !== undefined && 'motion-arrive')}
      style={place === undefined ? undefined : stagger(place)}
    >
      {showTime && <span className="mr-3 text-log-faint select-none">{clock(line.ts)}</span>}
      {line.line}
    </LogLine>
  );
}

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

  // The newest line's number, read from the whole list so a filter never slides old lines in. A list that is
  // already there when the page opens has nothing fresh; lines a later poll adds are the ones that slide.
  const tail = lines.at(-1)?.seq;
  const seenTail = useFreshAfter(data ? (tail ?? -1) : undefined);
  const freshAfter = seenTail === Number.NEGATIVE_INFINITY ? (tail ?? -1) : seenTail;

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

  const arriving = shown.filter((l) => l.seq > freshAfter).slice(-MAX_ARRIVING);

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
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4">
        <h2 className="m-0 mr-2 text-lg font-bold text-fg">Process logs</h2>
        <SegmentedControl options={STREAMS} value={stream} onChange={setStream} label="Stream" />
        <div className="min-w-48 flex-1">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter log lines"
            name="process-log-filter"
            autoComplete="off"
            placeholder="Filter…"
          />
        </div>
        <Button
          size="sm"
          variant={follow ? 'primary' : 'default'}
          aria-pressed={follow}
          onClick={() => setFollow((v) => !v)}
        >
          Follow
        </Button>
        <Button
          size="sm"
          variant={showTimes ? 'primary' : 'default'}
          aria-pressed={showTimes}
          onClick={() => setShowTimes((v) => !v)}
        >
          Times
        </Button>
        <CopyButton value={asText} />
        <Button size="sm" onClick={download} disabled={shown.length === 0}>
          Download
        </Button>
      </div>

      {error && data && (
        <div className="border-b border-line px-4 pt-4">
          <OfflineBanner
            message={`Process-log refresh failed — showing the last received lines. ${error.message}`}
            onRetry={refetch}
          />
        </div>
      )}

      {loading && !data && !error ? (
        <div className="min-h-40 p-4">
          <LoadingState label="Loading process logs…" />
        </div>
      ) : error && !data ? (
        <div className="min-h-40 p-4">
          <ErrorState error={error} onRetry={refetch} />
        </div>
      ) : (
        <div className="bg-log-bg text-log-fg">
          <LogScroll
            ref={scrollRef}
            role="region"
            aria-label="Process output"
            tabIndex={0}
            className="min-h-40 pt-3"
          >
            {shown.length === 0 ? (
              <p className="m-0 px-4 text-log-dim">
                {lines.length === 0 ? 'No output yet.' : 'No lines match the current filter.'}
              </p>
            ) : (
              shown.map((l) => {
                const place = arriving.indexOf(l);
                return (
                  <ProcessLine
                    key={l.seq}
                    line={l}
                    showTime={showTimes}
                    arrive={place < 0 ? undefined : place}
                  />
                );
              })
            )}
          </LogScroll>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] text-muted">
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

// Local poll so the panel owns its own cadence without touching the page fetch.
function usePolledLogs() {
  return usePolledData(() => bq.control.logs(), []);
}
