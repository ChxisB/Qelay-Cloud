import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { StatusGlyph } from '@/components/ui/StatusBadge';
import { Wash } from '@/components/ui/Wash';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import type { FleetNodeSnapshot } from './fleetClient';

/** The glyph beside the word that already names the state, so colour is never the only cue. */
function Dot({ ok, reachable }: { ok: boolean; reachable: boolean }) {
  return <StatusGlyph small state={!reachable ? 'failed' : ok ? 'completed' : 'delayed'} />;
}

export function FleetNodeCard({
  snapshot,
  active,
  busy,
  actionError,
  arrive,
  onActivate,
  onAction,
}: {
  snapshot: FleetNodeSnapshot;
  active: boolean;
  busy?: string;
  actionError?: string;
  /** The card's place in the first load's stagger; left out for a card a later poll adds. */
  arrive?: number;
  onActivate: () => void;
  onAction: (action: 'start' | 'stop' | 'restart') => void;
}) {
  // Read once, at mount: the first poll's cards rise, and a card a later poll adds does not.
  const [place] = useState(arrive);
  const { target, server, agent } = snapshot;
  const status = agent.status;
  const external = status?.managementMode === 'external';
  const running = external ? status?.reachable === true : status?.status === 'running';
  const transitioning =
    busy !== undefined || status?.status === 'starting' || status?.status === 'stopping';
  const storage =
    status?.storageMode === 'postgres'
      ? `PostgreSQL · ${status.postgresNamespace ?? 'default'}`
      : (status?.storageMode ?? 'unknown');

  return (
    <Card
      className={cn(
        'transition-colors duration-(--duration-hover) ease-settle',
        place !== undefined && 'motion-arrive',
        active && 'border-link/60'
      )}
      style={place === undefined ? undefined : stagger(place)}
    >
      <CardHeader
        title={target.name}
        action={
          active ? (
            <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-bold text-link">
              active
            </span>
          ) : (
            <Button size="sm" onClick={onActivate}>
              Use node
            </Button>
          )
        }
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-faint">Server</dt>
        <dd className="flex min-w-0 items-center gap-2 text-muted">
          <Dot ok={server.healthy} reachable={server.reachable} />
          <span className="truncate" title={target.baseUrl}>
            <Wash
              value={
                server.reachable
                  ? `${server.healthy ? 'healthy' : 'degraded'}${server.version ? ` · v${server.version}` : ''}`
                  : `offline · ${server.error ?? 'unreachable'}`
              }
            />
          </span>
        </dd>
        <dt className="text-faint">Agent</dt>
        <dd className="flex min-w-0 items-center gap-2 text-muted">
          <Dot ok={agent.healthy} reachable={agent.reachable} />
          <span className="truncate" title={target.agentBaseUrl}>
            <Wash
              value={
                agent.reachable
                  ? `${status?.status ?? 'connected'}${external ? ' · external' : ''}`
                  : `offline · ${agent.error ?? 'unreachable'}`
              }
            />
          </span>
        </dd>
        <dt className="text-faint">Storage</dt>
        <dd className="truncate font-mono text-muted" title={status?.postgresTarget}>
          {storage}
        </dd>
        {status?.storageMode === 'postgres' && (
          <>
            <dt className="text-faint">Cluster</dt>
            <dd className="truncate font-mono text-muted">
              {status.postgresTarget ?? 'configured PostgreSQL'}
            </dd>
          </>
        )}
      </dl>
      {actionError && (
        <p role="status" className="motion-arrive mt-3 text-xs text-danger">
          {actionError}
        </p>
      )}
      {!external && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            size="sm"
            disabled={!agent.reachable || running || transitioning}
            onClick={() => onAction('start')}
          >
            Start
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!agent.reachable || !running || transitioning}
            onClick={() => onAction('stop')}
          >
            Stop
          </Button>
          <Button
            size="sm"
            disabled={!agent.reachable || transitioning}
            onClick={() => onAction('restart')}
          >
            {busy === 'restart' ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      )}
    </Card>
  );
}
