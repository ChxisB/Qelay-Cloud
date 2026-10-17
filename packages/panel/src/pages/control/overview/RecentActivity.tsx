import { STATE_SOLID, stateRole } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { useActivityStream } from '@/lib/useActivityStream';

const ROWS = 6;

const VERB: Record<string, string> = { active: 'started', waiting: 'queued' };

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** Own SSE-subscribing leaf: live events re-render this list, not the tiles or the table. */
export function RecentActivity() {
  const { events, connected, error } = useActivityStream();
  const streamState = error ? 'Reconnecting…' : connected ? 'Live' : 'Connecting…';
  return (
    <section
      aria-label="Recent activity"
      className="flex min-w-0 flex-[1_1_280px] flex-col gap-3.5 rounded-card border border-line bg-surface p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Recent activity</h2>
        <span className={cn('text-xs', error ? 'text-warning' : 'text-muted')}>{streamState}</span>
      </div>
      {events.length === 0 ? (
        <p
          role={error ? 'alert' : undefined}
          className={cn('py-6 text-center text-sm', error ? 'text-warning' : 'text-faint')}
        >
          {error
            ? `Event stream unavailable — ${error.message}. Reconnecting…`
            : connected
              ? 'Waiting for live activity…'
              : 'Connecting to the event stream…'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {error && (
            <li className="pb-2 text-xs text-warning">
              Event stream unavailable — {error.message}. Reconnecting…
            </li>
          )}
          {events.slice(0, ROWS).map((event) => (
            <li
              key={event.seq}
              className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-2.5 last:border-b-0 last:pb-0"
            >
              <span
                className={cn('size-2 rounded-full', STATE_SOLID[stateRole(event.status)])}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-[13px] text-fg">
                Job {VERB[event.status] ?? event.status}
                {event.queue && (
                  <>
                    {' · '}
                    <span className="text-muted">{event.queue}</span>
                  </>
                )}
              </span>
              <span className="font-mono text-[11px] text-muted">{clock(event.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
