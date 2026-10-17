import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import type { ServerConfig, ServerStatus } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';

/** Live process vitals from the server's /health (null while it is stopped). */
export interface ServerVitals {
  memory?: { rss?: number; heapUsed?: number; heapTotal?: number };
  connections?: { tcp?: number; ws?: number; sse?: number };
}

function Fact({
  label,
  title,
  mono = false,
  children,
}: {
  label: string;
  title?: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" title={title}>
      <div className="eyebrow text-muted">{label}</div>
      <div className={cn('truncate text-sm font-medium tnum', mono && 'font-mono text-[13px]')}>
        {children}
      </div>
    </div>
  );
}

const dash = <span className="text-faint">—</span>;

function storageFact(status: ServerStatus | null, external: boolean) {
  if (external) return 'managed elsewhere';
  if (status?.storageMode === 'postgres')
    return `postgres · ${status.postgresNamespace ?? 'default'}`;
  return status?.storageMode ?? '—';
}

/**
 * The facts under the status bar: vitals, endpoints, ports and the exact command the agent
 * launches. An external server has no process to describe, so it gets the health facts instead.
 */
export function StatusFacts({
  status,
  vitals,
  agentBase,
  external,
  running,
  cfg,
  serverBase,
  healthEndpoint,
}: {
  status: ServerStatus | null;
  vitals: ServerVitals | null;
  agentBase: string;
  external: boolean;
  running: boolean;
  cfg: ServerConfig | null;
  serverBase: string;
  healthEndpoint: string;
}) {
  const connections = vitals?.connections;
  const totalConnections =
    (connections?.tcp ?? 0) + (connections?.ws ?? 0) + (connections?.sse ?? 0);
  const command = external ? null : (cfg?.command ?? null);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-6 gap-y-5 border-t border-line px-6 py-5">
      <Fact label="Memory">
        {vitals?.memory?.rss != null ? (
          <span
            title={`heap ${vitals.memory.heapUsed ?? '?'} / ${vitals.memory.heapTotal ?? '?'} MB`}
          >
            {vitals.memory.rss} MB
          </span>
        ) : (
          dash
        )}
      </Fact>
      <Fact label="Connections">
        {connections ? (
          <span
            title={`${connections.tcp ?? 0} tcp · ${connections.ws ?? 0} ws · ${connections.sse ?? 0} sse`}
          >
            {totalConnections}
          </span>
        ) : (
          dash
        )}
      </Fact>
      <Fact label={external ? 'Health target' : 'API endpoint'} title={healthEndpoint} mono>
        {serverBase !== '—' ? (
          <span className="flex items-center gap-1.5">
            <a
              href={healthEndpoint}
              target="_blank"
              rel="noreferrer"
              className="truncate text-link hover:underline"
            >
              {serverBase.replace(/^https?:\/\//, '')}
            </a>
            <CopyButton value={serverBase} />
          </span>
        ) : (
          <span className="text-faint">{serverBase}</span>
        )}
      </Fact>
      <Fact label={external ? 'Lifecycle' : 'Ports'}>
        {external ? 'external' : cfg ? `${cfg.httpPort} http · ${cfg.tcpPort} tcp` : '—'}
      </Fact>
      <Fact label={external ? 'Health HTTP' : 'Started'}>
        {external
          ? (status?.healthStatus ?? '—')
          : running && status?.startedAt
            ? formatDateTime(status.startedAt)
            : '—'}
      </Fact>
      <Fact label="Control agent" title={agentBase} mono>
        {agentBase.replace(/^https?:\/\//, '')}
      </Fact>
      <Fact
        label={external ? 'Supervisor' : 'Storage'}
        title={
          status?.storageMode === 'postgres'
            ? `PostgreSQL ${status.postgresTarget ?? 'configured'} · namespace ${status.postgresNamespace ?? 'default'}`
            : status?.storageMode
        }
      >
        {storageFact(status, external)}
      </Fact>
      {command && (
        <div className="col-span-full flex min-w-0 flex-col gap-1.5">
          <div className="eyebrow text-muted">Launch command</div>
          <div className="flex items-center gap-2 rounded-control border border-line bg-bg px-3 py-2.5 light:bg-surface-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-fg">
              {command}
            </code>
            <CopyButton value={command} />
          </div>
        </div>
      )}
    </div>
  );
}
