import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { SystemTabs } from '@/components/SystemTabs';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import {
  type FleetNodeSnapshot,
  postgresTopologyKey,
  probeFleet,
  runFleetLifecycle,
} from '@/features/fleet/fleetClient';
import { FleetNodeCard } from '@/features/fleet/FleetNodeCard';
import { cn } from '@/lib/cn';
import { useControlConnectionEpoch } from '@/lib/controlConnectionEpoch';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { usePolledData } from '@/lib/usePolledData';

// The placeholder for the node cards: same block as the other loading states, flat under reduced motion.
const SKELETON = 'block rounded-card bg-slate-tint motion-safe:animate-pulse';

function topologyGroups(nodes: readonly FleetNodeSnapshot[]) {
  const groups = new Map<string, FleetNodeSnapshot[]>();
  for (const node of nodes) {
    const key = postgresTopologyKey(node);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const status = members[0]?.agent.status;
    return {
      key,
      target: status?.postgresTarget ?? 'configured PostgreSQL',
      namespace: status?.postgresNamespace ?? 'default',
      members,
    };
  });
}

export function Fleet() {
  const profiles = useConnectionStore((state) => state.profiles);
  const activeProfileId = useConnectionStore((state) => state.activeProfileId);
  const activateProfile = useConnectionStore((state) => state.activateProfile);
  const connectionEpoch = useControlConnectionEpoch();
  const profileIds = profiles.map((profile) => profile.id);
  // Include metadata for every node and the secret-free active-connection epoch.
  // Endpoint or credential edits must abort an old probe/action immediately.
  const fleetKey = `${connectionEpoch}:${JSON.stringify(profiles)}`;
  const { data, error, loading, refetch } = usePolledData(
    (signal) => probeFleet(profileIds, signal),
    [fleetKey],
    { intervalMs: 10_000 }
  );
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const actionGeneration = useRef(0);
  const asking = useRef(new Set<string>());
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = useFirstLoad(data !== null);
  const topology = useMemo(() => topologyGroups(data ?? []), [data]);

  useEffect(() => {
    actionGeneration.current += 1;
    setBusy({});
    setActionErrors({});
  }, [fleetKey]);

  const act = async (snapshot: FleetNodeSnapshot, action: 'start' | 'stop' | 'restart') => {
    const id = snapshot.target.id;
    if (busy[id] || asking.current.has(id)) return;
    const generation = actionGeneration.current;
    if (action !== 'start') {
      const verb = action === 'stop' ? 'Stop' : 'Restart';
      asking.current.add(id);
      const yes = await confirmInPage({
        question: `${verb} this node?`,
        confirmLabel: `${verb} node`,
        danger: action === 'stop',
        detail: `${verb} ${snapshot.target.name}? In-flight jobs on this broker may be interrupted.`,
      }).finally(() => asking.current.delete(id));
      // A connection edited while the question was open ends the action, as it does for a running one.
      if (!yes || generation !== actionGeneration.current) return;
    }
    setBusy((current) => ({ ...current, [id]: action }));
    setActionErrors((current) => ({ ...current, [id]: '' }));
    try {
      await runFleetLifecycle(id, action);
      if (generation === actionGeneration.current) await refetch();
    } catch (failure) {
      if (generation === actionGeneration.current) {
        setActionErrors((current) => ({ ...current, [id]: (failure as Error).message }));
      }
    } finally {
      if (generation === actionGeneration.current) {
        setBusy((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    }
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Fleet"
        description="Operate every server node and verify shared PostgreSQL topology."
        actions={
          <Button aria-disabled={refreshing || undefined} onClick={() => void refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh all'}
          </Button>
        }
      />
      <SystemTabs current="/fleet" />

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Configured nodes" value={profiles.length} />
        <StatCard
          label="Healthy APIs"
          value={`${(data ?? []).filter((node) => node.server.healthy).length}/${profiles.length}`}
        />
        <StatCard label="PostgreSQL clusters" value={topology.length} />
      </div>

      {error && (
        <div className="mb-4">
          <Banner title="Fleet refresh failed">{error.message}</Banner>
        </div>
      )}

      {topology.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Shared PostgreSQL topology" />
          <div className="flex flex-col gap-3">
            {topology.map((group) => (
              <div
                key={group.key}
                className="rounded-[18px] border border-line bg-surface-2/40 px-4 py-3"
              >
                <div className="font-mono text-sm text-fg">{group.target}</div>
                <div className="mt-1 text-xs text-muted">
                  namespace <span className="font-mono text-fg">{group.namespace}</span> ·{' '}
                  {group.members.length} broker{group.members.length === 1 ? '' : 's'}:{' '}
                  {group.members.map((node) => node.target.name).join(', ')}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {loading && !data ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted">Checking every server node…</p>
          <div aria-hidden="true" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <span className={cn(SKELETON, 'h-56')} />
            <span className={cn(SKELETON, 'h-56')} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {(data ?? []).map((snapshot, index) => (
            <FleetNodeCard
              key={snapshot.target.id}
              snapshot={snapshot}
              active={snapshot.target.id === activeProfileId}
              busy={busy[snapshot.target.id]}
              actionError={actionErrors[snapshot.target.id]}
              arrive={firstLoad ? index : undefined}
              onActivate={() => activateProfile(snapshot.target.id)}
              onAction={(action) => void act(snapshot, action)}
            />
          ))}
        </div>
      )}

      <p className="mt-5 text-xs leading-relaxed text-faint">
        PostgreSQL-backed queues, jobs, flows, crons, workers, limits, durable metrics and events
        are visible through every healthy broker in the same target and namespace. Lifecycle,
        process logs/configuration and in-memory webhooks are node-local; Workflow Engine storage
        uses each profile&apos;s agent data path.
      </p>
    </div>
  );
}
