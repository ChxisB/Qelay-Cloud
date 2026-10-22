import { useEffect, useMemo, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { Banner } from '@/components/ui/Banner';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconCheck, IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusGlyph } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { STALE_EXPLAINER, type Sort, type SortKey, WorkersTable } from './workers/WorkersTable';

const MAX_ROWS = 100;

export function WorkersPro() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(async () => {
    const r = await bq.workers();
    return r.data;
  }, []);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  const actionGuard = useServerActionGuard('workers-pro');

  const workers = useMemo(() => data?.workers ?? [], [data]);
  // Memoized: the table keeps a row that has just left in view, and finds out which by comparing this list.
  const rows = useMemo(() => {
    const sorted = sort
      ? [...workers].sort((a, b) => {
          const va = sort.key === 'failed' ? (a.failedJobs ?? 0) : (a.lastSeen ?? 0);
          const vb = sort.key === 'failed' ? (b.failedJobs ?? 0) : (b.lastSeen ?? 0);
          return sort.dir === 'asc' ? va - vb : vb - va;
        })
      : workers;
    return sorted.slice(0, MAX_ROWS);
  }, [workers, sort]);

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusyIds(new Set());
    setMsg(null);
  }, [actionGuard.scopeKey]);

  if (loading && !data && !error) return <LoadingState label="Loading workers…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Workers" description="Worker inventory is unavailable." />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const quarantinedWorkers = data?.quarantinedWorkers ?? [];
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    );
  const activeWorkers = workers.filter((w) => w.status === 'active').length;
  const staleWorkers = workers.length - activeWorkers;
  const activeJobs = workers.reduce((sum, w) => sum + (w.activeJobs ?? 0), 0);

  const removeStaleRegistration = async (id: string) => {
    const sure = await confirmInPage({
      question: `Remove the stale registry record for worker "${id}"?`,
      detail:
        'This does not stop the worker process. Continue only after confirming that process is stopped; Qelay workers do not automatically re-register after their heartbeat record is removed.',
      confirmLabel: 'Remove record',
      danger: true,
    });
    if (!sure) return;
    const lease = actionGuard.begin(`worker:${id}`);
    if (!lease) return;
    setBusyIds((s) => new Set(s).add(id));
    setMsg(null);
    try {
      const response = await bq.unregisterWorker(id);
      assertSuccessfulMutationResponse(response, 'Remove stale worker registry record');
      if (!lease.isCurrent()) return;
      setMsg({ ok: true, text: `Removed stale registry record for ${id}` });
      void refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      setMsg({ ok: false, text: `Removal failed: ${(e as Error).message}` });
    } finally {
      if (lease.finish()) {
        setBusyIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    }
  };

  return (
    <div>
      <PageHeader
        title="Workers"
        description="Every process that claims jobs. One that stops reporting goes stale."
        live={!!data && !error}
      />
      {error && (
        <OfflineBanner
          message="Worker refresh failed — showing the last successful inventory."
          onRetry={refetch}
        />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard
          label="Total"
          value={formatNumber(workers.length + quarantinedWorkers.length)}
          compact
        />
        <StatCard label="Active" value={formatNumber(activeWorkers)} tone="green" compact />
        <div title={STALE_EXPLAINER}>
          <StatCard
            label="Stale"
            value={formatNumber(staleWorkers)}
            tone={staleWorkers ? 'amber' : 'default'}
            hint={
              staleWorkers ? (
                <span className="inline-flex items-center gap-1.5">
                  <StatusGlyph state="delayed" small />
                  No heartbeat recently
                </span>
              ) : undefined
            }
            compact
          />
        </div>
        <StatCard label="Active jobs" value={formatNumber(activeJobs)} tone="active" compact />
        <StatCard
          label="Quarantined"
          value={formatNumber(quarantinedWorkers.length)}
          tone={quarantinedWorkers.length ? 'red' : 'default'}
          hint={
            quarantinedWorkers.length ? (
              <span className="inline-flex items-center gap-1.5">
                <StatusGlyph state="failed" small />
                Cannot be shown
              </span>
            ) : undefined
          }
          compact
        />
      </div>

      {quarantinedWorkers.length > 0 && (
        <div className="mb-4">
          <Banner
            tone="problem"
            title={`${quarantinedWorkers.length} worker registration(s) cannot be shown`}
          >
            They contain values accepted by Qelay but unsafe to render. Healthy workers remain
            available below. Their status and active-job count are unknown, so this dashboard will
            not offer the registry-only removal action for them.
          </Banner>
          <ul className="mt-2 space-y-1 px-1 text-xs text-muted">
            {quarantinedWorkers.slice(0, 20).map((issue) => (
              <li key={`${issue.index}:${issue.id ?? 'unknown'}`} className="truncate font-mono">
                #{issue.index + 1} {issue.id ?? '(unaddressable id)'} — {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && (
        <div className="mb-4">
          <Banner
            tone={msg.ok ? 'ok' : 'problem'}
            title={msg.ok ? 'Worker removed' : 'Removal failed'}
          >
            <span className="inline-flex items-center gap-1.5">
              {msg.ok && <IconCheck className="size-4 shrink-0 text-success" />}
              {msg.text}
            </span>
          </Banner>
        </div>
      )}

      {workers.length === 0 ? (
        <EmptyState
          icon={<IconWorkers />}
          title={quarantinedWorkers.length ? 'No renderable workers' : 'No workers registered'}
          hint={
            quarantinedWorkers.length
              ? 'Malformed registrations are isolated above instead of taking down the inventory.'
              : 'Workers appear here once they connect and register with the server.'
          }
        />
      ) : (
        <WorkersTable
          rows={rows}
          canOperate={canOperate}
          sort={sort}
          onSort={toggleSort}
          busyIds={busyIds}
          onRemove={removeStaleRegistration}
        />
      )}

      {workers.length > MAX_ROWS && (
        <p className="mt-3 text-[13px] font-semibold text-warning">
          Showing first {formatNumber(MAX_ROWS)} of {formatNumber(workers.length)} workers.
        </p>
      )}
    </div>
  );
}
