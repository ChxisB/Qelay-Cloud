import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { Hit, type LogLevel, LogFoot, LogLine, LogScroll } from '@/components/ui/LogViewer';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import type { ActivityEvent } from '@/lib/types';

const LEVEL: Partial<Record<string, LogLevel>> = {
  failed: 'error',
  completed: 'ok',
  waiting: 'dim',
};

export const levelOf = (status: string): LogLevel => LEVEL[status] ?? 'info';

/** Every case-insensitive occurrence of `term` in `text`, wrapped in a highlight. */
export function markHits(text: string, term: string): ReactNode {
  if (!term) return text;
  // A capture group makes `split` keep the matches, at the odd indexes. The term is taken literally.
  const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'));
  return parts.length === 1
    ? text
    : parts.map((part, i) => (i % 2 ? <Hit key={i}>{part}</Hit> : part));
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

const pressKey = (act: () => void) => (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  act();
};

// Only the newest few lines of an update slide in; a burst of hundreds appears at once behind them.
const MAX_ARRIVING = 8;

/** One line. Whether it slides in is read once, when it appears: a later update must not cut the slide short. */
function EventLine({
  event: e,
  term,
  selected,
  onSelect,
  arrive,
}: {
  event: ActivityEvent;
  term: string;
  selected: boolean;
  onSelect: (seq: number) => void;
  arrive: number | undefined;
}) {
  const [place] = useState(arrive);
  const level = levelOf(e.status);
  return (
    <LogLine
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(e.seq)}
      onKeyDown={pressKey(() => onSelect(e.seq))}
      time={clock(e.timestamp)}
      queue={e.queue ? markHits(e.queue, term) : '—'}
      job={e.jobId ? markHits(e.jobId, term) : '—'}
      level={level}
      title={new Date(e.timestamp).toISOString()}
      style={place === undefined ? undefined : stagger(place)}
      className={cn(
        'cursor-pointer',
        selected && 'bg-log-hover shadow-[inset_3px_0_0_var(--log-on)]',
        place !== undefined && 'motion-arrive'
      )}
    >
      {level === 'error' ? null : (
        <span className="mr-3 text-[12px] font-bold tracking-wide uppercase">{e.status}</span>
      )}
      {e.event}
      {e.status === 'failed' && e.error && <span className="ml-3">{e.error}</span>}
    </LogLine>
  );
}

/**
 * Newest first. A line is a button: selecting it opens the full record under the viewer. Lines numbered above
 * `freshAfter` (see `useFreshAfter`) slide in, newest first and in order; with none given nothing does.
 */
export function LogsEventList({
  rows,
  term,
  selectedSeq,
  onSelect,
  empty,
  total,
  bufferSize,
  freshAfter = Number.POSITIVE_INFINITY,
}: {
  rows: ActivityEvent[];
  term: string;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  empty: string;
  total: number;
  bufferSize: number;
  freshAfter?: number;
}) {
  const arriving = rows.filter((e) => e.seq > freshAfter).slice(0, MAX_ARRIVING);
  return (
    <>
      <LogScroll role="log" aria-label="Activity events">
        {rows.length === 0 ? (
          <p className="px-4 py-12 text-center font-sans text-sm text-log-dim">{empty}</p>
        ) : (
          rows.map((e) => {
            const place = arriving.indexOf(e);
            return (
              <EventLine
                key={e.seq}
                event={e}
                term={term}
                selected={e.seq === selectedSeq}
                onSelect={onSelect}
                arrive={place < 0 ? undefined : place}
              />
            );
          })
        )}
      </LogScroll>
      <LogFoot>
        <span>
          Showing {rows.length} of {total} events, newest first
        </span>
        <span>
          Search and filters cover the last {bufferSize} streamed events held in this browser.
        </span>
      </LogFoot>
    </>
  );
}
