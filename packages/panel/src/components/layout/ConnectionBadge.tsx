import { useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { StatusPill, type StateRole } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { usePolledData } from '@/lib/usePolledData';

type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'offline';

const STATE_META: Record<ConnectionState, { role: StateRole; word: string; label: string }> = {
  connecting: { role: 'active', word: 'Checking', label: 'connecting' },
  connected: { role: 'completed', word: 'Healthy', label: 'connected' },
  degraded: { role: 'waiting', word: 'Degraded', label: 'reachable, degraded' },
  offline: { role: 'failed', word: 'Offline', label: 'offline' },
};

/** What the status line says when a poll moves the state; "checking" is not a poll result, so it has none. */
const SAY: Partial<Record<ConnectionState, string>> = {
  connected: 'Control API is healthy.',
  degraded: 'Control API is reachable but degraded.',
  offline: 'Control API is not answering.',
};

/**
 * The design's health card. It says only what the shell knows: the Control API's state from the
 * 15 s `/health` poll and which node that is. `/ready` carries nothing more (a disk-full flag), so
 * no claim is made about Postgres, the broker or the tick. When a poll moves the state between two
 * answers, the pill flashes once and a status line under the card says it in words (and is announced).
 * The first answer, a poll that returns the same state, and a switch of connection stay quiet.
 */
export function ConnectionBadge() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  // /health returns HTTP 503 with `ok:false` when the server is reachable but
  // degraded (for example, disk full). That differs from a transport failure.
  const { data, error, loading } = usePolledData(
    async () => {
      const health = await api.health();
      if (typeof health.ok !== 'boolean') throw new Error('Malformed health response');
      return { healthy: health.ok };
    },
    [],
    { intervalMs: 15000 }
  );
  const state: ConnectionState = loading
    ? 'connecting'
    : error || !data
      ? 'offline'
      : data.healthy
        ? 'connected'
        : 'degraded';
  const meta = STATE_META[state];
  const [last, setLast] = useState(state);
  const [said, setSaid] = useState<ConnectionState | null>(null);
  if (state !== last) {
    setLast(state);
    if (state !== 'connecting' && last !== 'connecting') setSaid(state);
  }
  const flash = useChangeFlash(said);
  const host = baseUrl.replace(/^https?:\/\//, '') || 'local';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex flex-col items-start gap-1.5 overflow-hidden rounded-[22px] border border-line bg-sidebar p-4">
        <svg
          viewBox="0 0 150 150"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          className="pointer-events-none absolute -right-[46px] -bottom-[52px] size-[150px] text-line"
        >
          {[72, 54, 36, 18].map((r) => (
            <circle key={r} cx="75" cy="75" r={r} strokeWidth="1.5" />
          ))}
        </svg>
        <span key={flash} className={cn('relative', flash > 0 && 'motion-flash')}>
          <StatusPill state={meta.role}>{meta.word}</StatusPill>
        </span>
        <p className="relative max-w-[150px] text-[13px] font-semibold text-fg" title={meta.label}>
          Control API {meta.label}
        </p>
        <p className="relative max-w-full truncate text-xs text-faint" title={baseUrl}>
          {host}
        </p>
      </div>
      {/* Always in the page, so a change inside it is announced; empty and unseen until a poll moves the state. */}
      <p role="status" className={said ? 'px-1.5 text-xs text-muted' : 'sr-only'}>
        {said && (
          <span key={flash} className="motion-arrive block">
            {SAY[said]}
          </span>
        )}
      </p>
    </div>
  );
}
