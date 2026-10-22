import { Button } from '@/components/ui/Button';
import { StatusGlyph } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';

export interface ServerStrip {
  host: string;
  version: string | null;
  uptime: string;
  ram: string;
}

/** Leaf component: the per-second clock re-renders only this text. */
function UpdatedAgo({ at }: { at: number }) {
  const now = useNow(1000);
  return <span>Updated {at > 0 ? formatRelativeTime(at, now) : '—'}</span>;
}

export function OverviewHeader({
  live,
  paused,
  degraded,
  strip,
  updatedAt,
  onTogglePause,
}: {
  live: boolean;
  paused: boolean;
  degraded: boolean;
  strip: ServerStrip;
  updatedAt: number;
  onTogglePause: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em] text-fg">Home</h1>
          {(live || paused) && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full py-[3px] pl-2 pr-2.5 text-xs font-medium',
                paused
                  ? 'bg-state-waiting-bg text-state-waiting-fg'
                  : 'bg-state-completed-bg text-state-completed-fg'
              )}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {paused ? 'Paused' : 'Live'}
            </span>
          )}
        </div>
        <p className="max-w-[680px] text-sm text-pretty text-muted">
          Every queue, worker and connection at a glance, with the things that need a person at the
          top.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted">
          <span
            className={cn(
              'inline-flex items-center gap-2 font-medium',
              degraded ? 'text-warning' : 'text-fg'
            )}
          >
            <StatusGlyph state={degraded ? 'delayed' : 'completed'} small />
            {degraded ? 'Connection lost — showing last known data' : 'Server connected'}
          </span>
          <span className="font-mono text-xs">{strip.host}</span>
          {strip.version && <span>v{strip.version}</span>}
          <span>Up {strip.uptime}</span>
          <span>{strip.ram}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <UpdatedAgo at={updatedAt} />
        <Button onClick={onTogglePause}>{paused ? 'Resume' : 'Pause'}</Button>
      </div>
    </div>
  );
}
