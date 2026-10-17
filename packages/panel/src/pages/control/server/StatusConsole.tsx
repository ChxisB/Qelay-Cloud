import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconRefresh } from '@/components/ui/icons';
import { STATE_PILL } from '@/components/ui/StatusBadge';
import type { ServerStatus } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatUptime } from '@/lib/format';
import { type ServerVitals, StatusFacts } from './StatusFacts';

interface Props {
  status: ServerStatus | null;
  agentBase: string;
  transitioning: boolean;
  /** Agent poll failing — `status` is the last known snapshot, not live truth. */
  stale?: boolean;
  /** Live process vitals from the server's /health (null while stopped). */
  vitals?: ServerVitals | null;
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}

const STATE_META: Record<string, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'bg-success' },
  starting: { label: 'Starting', dot: 'bg-warning' },
  stopping: { label: 'Stopping', dot: 'bg-warning' },
  stopped: { label: 'Stopped', dot: 'bg-danger-fill' },
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Ticks once a second so the console reads live without re-rendering the page. */
function UptimeTicker({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatUptime((Date.now() - startedAt) / 1000)}</>;
}

function Pill({ tone, children }: { tone: keyof typeof STATE_PILL; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full py-[3px] pl-2 pr-2.5 text-xs font-medium',
        STATE_PILL[tone]
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/**
 * The server's status bar: what state it is in, the three lifecycle buttons and the facts
 * underneath. It carries this screen's single brand gradient, as its top rule.
 */
export function StatusConsole({
  status,
  agentBase,
  transitioning,
  stale = false,
  vitals = null,
  busy,
  onStart,
  onStop,
  onRestart,
}: Props) {
  const state = status?.status ?? 'stopped';
  const external = status?.managementMode === 'external';
  const running = external ? status?.reachable === true : state === 'running';
  const healthy = !!status?.healthy && !stale;
  const crashed = !external && !running && status?.exitCode != null && status.exitCode !== 0;

  const meta = external
    ? {
        label: 'External',
        dot: healthy ? 'bg-success' : status?.reachable ? 'bg-warning' : 'bg-danger-fill',
      }
    : (STATE_META[state] ?? STATE_META.stopped);

  const cfg = status?.runningConfig ?? status?.config ?? null;
  const httpPort = cfg?.httpPort ?? 6790;
  const serverBase = external ? (status?.externalUrl ?? '—') : `http://localhost:${httpPort}`;
  const healthEndpoint = serverBase === '—' ? '—' : `${serverBase}/health`;

  return (
    <section
      aria-label="Server status"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div
        aria-hidden
        className="h-[3px] bg-[linear-gradient(90deg,var(--brand-1),var(--brand-2),var(--brand-3))]"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 py-5">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-2.5 text-[22px] font-bold tracking-tight text-fg">
              <span className="relative flex size-2.5 shrink-0">
                {running && healthy && !transitioning && (
                  <span className="absolute inline-flex size-full rounded-full bg-success opacity-50 motion-safe:animate-ping" />
                )}
                <span className={cn('relative inline-flex size-2.5 rounded-full', meta.dot)} />
              </span>
              {transitioning && busy ? `${capitalize(busy)}…` : meta.label}
            </span>
            {stale ? (
              <Pill tone="delayed">Agent unreachable</Pill>
            ) : crashed ? (
              <Pill tone="failed">{`Crashed · exit ${status?.exitCode}`}</Pill>
            ) : running && healthy ? (
              <Pill tone="completed">Healthy</Pill>
            ) : running ? (
              <Pill tone="delayed">{external ? 'Unhealthy' : 'Waiting for health'}</Pill>
            ) : external ? (
              <Pill tone="failed">Unreachable</Pill>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            {stale ? (
              <span className="text-warning">
                Last known: pid {status?.pid ?? '—'} — agent unreachable, state may have changed
              </span>
            ) : external ? (
              <span title={status?.healthError} className="font-mono text-xs">
                {status?.reachable
                  ? healthy
                    ? `healthy via ${healthEndpoint}`
                    : `reachable but unhealthy via ${healthEndpoint}`
                  : `unreachable via ${healthEndpoint}`}
              </span>
            ) : running ? (
              <>
                {status?.version && <span>v{status.version}</span>}
                <span>
                  pid <span className="font-mono text-fg">{status?.pid ?? '—'}</span>
                </span>
                <span>
                  Up {status?.startedAt ? <UptimeTicker startedAt={status.startedAt} /> : '—'}
                </span>
              </>
            ) : (
              <span>
                The server is not running — start it, or point the dashboard at an external server.
              </span>
            )}
          </div>
        </div>

        {!external && (
          <div className="flex flex-wrap items-center gap-2.5">
            <Button disabled={running || transitioning || stale} onClick={onStart}>
              Start
            </Button>
            <Button variant="danger" disabled={!running || transitioning || stale} onClick={onStop}>
              Stop
            </Button>
            <Button disabled={transitioning || stale} onClick={onRestart}>
              <IconRefresh className="size-4" /> Restart
            </Button>
          </div>
        )}
      </div>

      <StatusFacts
        status={status}
        vitals={vitals}
        agentBase={agentBase}
        external={external}
        running={running}
        cfg={cfg}
        serverBase={serverBase}
        healthEndpoint={healthEndpoint}
      />
    </section>
  );
}
