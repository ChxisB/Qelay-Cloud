import { useEffect, useRef, useState } from 'react';
import { type ConfirmOptions, confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { SystemTabs } from '@/components/SystemTabs';
import { Banner } from '@/components/ui/Banner';
import { Card, CardHeader } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import { useControlActionGuard } from '@/lib/useControlActionGuard';
import { usePolledData } from '@/lib/usePolledData';
import { AgentInfoCard } from './server/AgentInfoCard';
import { ConfigCard } from './server/ConfigCard';
import { diskHealthOf } from './server/diskHealth';
import { ProcessLogs } from './server/ProcessLogs';
import { StatusConsole } from './server/StatusConsole';
import type { ServerVitals } from './server/StatusFacts';
import { StoragePanel } from './server/StoragePanel';

export function ServerControl() {
  const statusRequestSequence = useRef(0);
  const statusRequestIds = useRef(new WeakMap<object, number>());
  const { data, error, refetch } = usePolledData(async () => {
    const requestId = ++statusRequestSequence.current;
    const result = await bq.control.status();
    statusRequestIds.current.set(result, requestId);
    return result;
  }, []);
  const actionGuard = useControlActionGuard('server-lifecycle');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(null);
    setActionError(null);
  }, [actionGuard.scopeKey]);

  // RAM + connections come from the server's own /health, not the agent —
  // only poll it while the process is running (it can't answer otherwise).
  const external = data?.managementMode === 'external';
  const serverUp = external ? data?.reachable === true : data?.status === 'running';
  const { data: health } = usePolledData(
    () => (serverUp ? bq.health() : Promise.resolve(null)),
    [serverUp]
  );
  const vitals = serverUp ? ((health ?? null) as ServerVitals | null) : null;
  // Disk health is the server's own word (GET /storage). Unknown — stopped, or the call
  // failing — stays unknown: the Storage panel then says nothing instead of "healthy".
  const { data: storage } = usePolledData(
    () => (serverUp ? bq.storage().catch(() => null) : Promise.resolve(null)),
    [serverUp]
  );
  const disk = serverUp ? diskHealthOf(storage) : null;

  // Spell out the blast radius in stop/restart confirms: live connection counts
  // when /health has them, so the operator knows what a kill actually severs.
  const blastRadius = vitals?.connections
    ? `This drops ${vitals.connections.tcp ?? 0} TCP / ${vitals.connections.ws ?? 0} WS connections; in-flight jobs are interrupted.`
    : 'In-flight jobs are interrupted.';

  // The lease is held while the question is open, so a second click cannot send the action twice.
  const run = async (label: string, fn: () => Promise<unknown>, confirm?: ConfirmOptions) => {
    const lease = actionGuard.begin('lifecycle');
    if (!lease) return;
    if (confirm && !(await confirmInPage(confirm))) {
      lease.finish();
      return;
    }
    if (!lease.isCurrent()) {
      lease.finish();
      return;
    }
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      if (!lease.isCurrent()) return;
      await refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      setActionError((e as Error).message);
    } finally {
      if (lease.finish()) setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Server" description="Start, stop and restart the server." />
        <SystemTabs current="/server" />
        <OfflineBanner
          message="Control agent unreachable — server lifecycle controls are unavailable."
          onRetry={refetch}
        />
        <Card>
          <CardHeader title="Control agent not running" />
          <p className="text-sm text-muted">
            The local control agent is unreachable at{' '}
            <code className="rounded-control bg-slate-tint px-1.5 py-0.5 font-mono text-[13px]">
              {bq.agentBase}
            </code>
            . It manages the server process (start / stop / restart). Start it with:
          </p>
          <div className="mt-3">
            <CodeBlock label="Start the control agent">
              {'bun start      # agent + dashboard together (recommended)\n'}
              {'bun run agent   # agent only, if the dashboard is already running'}
            </CodeBlock>
          </div>
          <p className="mt-3 text-[13px] text-muted">
            This page reconnects automatically once the agent is up — no reload needed.
          </p>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Server" description="Supervise the server process." />
        <SystemTabs current="/server" />
        <LoadingState label="Reaching the control agent…" />
      </div>
    );
  }

  const status = data.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'stopping' || busy != null;
  // Agent was reachable once (data cached) but the poll now fails — without
  // this the console keeps asserting "Running / healthy" with a live-ticking
  // uptime for an agent (and possibly server) that is dead.
  const stale = error != null;

  return (
    <div>
      <PageHeader
        title="Server"
        description={
          external
            ? 'Observe the server managed by an external supervisor.'
            : 'Supervise the server process — lifecycle, configuration, storage and logs.'
        }
      />
      <SystemTabs current="/server" />

      <div className="flex flex-col gap-6">
        {actionError && (
          <Banner tone="problem" title="The server action did not go through">
            {actionError}
          </Banner>
        )}

        {stale && (
          <Banner tone="warn" title="Control agent unreachable">
            Showing the last known state. Lifecycle actions are disabled until it responds again.
          </Banner>
        )}

        <StatusConsole
          status={data}
          agentBase={bq.agentBase}
          stale={stale}
          vitals={vitals}
          transitioning={transitioning}
          busy={busy}
          onStart={() => run('starting', () => bq.control.start())}
          onStop={() =>
            run('stopping', () => bq.control.stop(), {
              question: 'Stop the server?',
              detail: blastRadius,
              confirmLabel: 'Stop server',
            })
          }
          onRestart={() =>
            run('restarting', () => bq.control.restart(), {
              question: 'Restart the server?',
              detail: blastRadius,
              confirmLabel: 'Restart server',
            })
          }
        />

        {external ? (
          <Card className="p-4">
            <CardHeader title="Managed externally" />
            <p className="text-sm text-muted">
              This control panel is attached to{' '}
              <code className="rounded-control bg-slate-tint px-1.5 py-0.5 font-mono text-[13px]">
                {data.externalUrl ?? 'QELAY_URL'}
              </code>
              . Start, stop, restart and launch configuration are intentionally unavailable while{' '}
              <code className="rounded-control bg-slate-tint px-1.5 py-0.5 font-mono text-[13px]">
                QELAY_MANAGED=0
              </code>
              . Use systemd, Docker, Kubernetes or the broker's external supervisor instead.
            </p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
              <ConfigCard
                status={data}
                onSaved={refetch}
                running={running}
                statusRequestId={statusRequestIds.current.get(data)}
                getStatusRequestSequence={() => statusRequestSequence.current}
                transitioning={transitioning}
              />
              {data.db && <StoragePanel db={data.db} disk={disk} />}
            </div>
            <ProcessLogs />
          </>
        )}

        <AgentInfoCard agentBase={bq.agentBase} />
      </div>
    </div>
  );
}
