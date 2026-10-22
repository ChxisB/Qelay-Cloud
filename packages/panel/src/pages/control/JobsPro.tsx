import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconPlus } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { actionGates } from '@/lib/jobActions';
import { usePolledData } from '@/lib/usePolledData';
import { exportJobs } from './jobsPro/exportJobs';
import { JobsHeadline } from './jobsPro/JobsHeadline';
import { JobsSelectionBar } from './jobsPro/JobsSelectionBar';
import { JobsTable } from './jobsPro/JobsTable';
import { JobStateTabs } from './jobsPro/JobStateTabs';
import { JobsToolbar } from './jobsPro/JobsToolbar';
import {
  emptyCopy,
  footerLabel,
  JOB_STATUSES,
  JOBS_PAGE_SIZE,
  type JobStatusFilter,
  jobsHeadline,
  matchesFilter,
  stateCount,
} from './jobsPro/model';
import { promoteConfirm } from './jobsPro/promoteConfirm';
import { useJobMutations } from './jobsPro/useJobMutations';
import { useJobsPage } from './jobsPro/useJobsPage';

export { selectionLabel, withoutActed } from './jobsPro/model';

export function JobsPro() {
  const canOperate = useCanOperate();
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? '');
  const [status, setStatus] = useState<JobStatusFilter>(() => {
    const s = params.get('status') as JobStatusFilter | null;
    return s && JOB_STATUSES.includes(s) ? s : 'all';
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Queue dropdown and per-state tab counts: one /queues/summary call (all queues), polled
  // slowly — the queue set changes rarely, so it doesn't ride the fast job cadence.
  const {
    data: summary,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchSummary,
  } = usePolledData(() => bq.queuesSummary(), [], { intervalMs: 30000 });

  // Default to the first queue once the list arrives (no cross-queue job list:
  // one server-paginated queue at a time). Also replace a stale ?queue= with no
  // <option>; without a summary the URL queue stays the only usable target.
  useEffect(() => {
    if (!summary || summary.some((q) => q.name === queue)) return;
    setQueue(summary[0]?.name ?? '');
    setPage(0);
  }, [summary, queue]);

  const { jobs, updatedAt, error, loading, refetch } = useJobsPage(queue, status, page);

  // No `total` from jobs/list — a full page means there may be a next one.
  const hasNext = (jobs?.length ?? 0) === JOBS_PAGE_SIZE;

  const term = search.trim().toLowerCase();
  const rows = useMemo(
    () => (term ? (jobs ?? []).filter((j) => matchesFilter(j, term)) : (jobs ?? [])),
    [jobs, term]
  );
  const counts = summary?.find((q) => q.name === queue)?.counts;
  const count = stateCount(counts, status);

  const resetPage = () => setPage(0);

  // Keep queue+status in the URL (replace, not push) so a filtered view is
  // shareable and survives back-navigation. Page is deliberately left out —
  // offsets go stale as jobs drain.
  const syncUrl = (q: string, s: JobStatusFilter) => {
    const next: Record<string, string> = {};
    if (q) next.queue = q;
    if (s !== 'all') next.status = s;
    setParams(next, { replace: true });
  };

  // A different page/queue/status shows different jobs — a selection made on
  // the old view must not silently carry over to rows it never referred to.
  // Clear selection whenever the rendered view changes.
  useEffect(() => {
    setSelected(new Set());
  }, [queue, status, page]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // Membership-based (not size-based): search can shrink `rows` while stale
  // ids remain selected, and sizes would then lie.
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(() => (allSelected ? new Set() : new Set(rows.map((r) => r.id))));

  const { actionMsg, bulkBusy, busyIds, runBulk, runOne } = useJobMutations({
    queue,
    rows,
    selected,
    setSelected,
    refetch,
  });

  // Per-action eligibility, shared by the button-enable check and runBulk's
  // target filter so the two can't drift.
  const eligibleFor = {
    promote: (j: JobFull) => actionGates(j.state).promote,
  };
  const selectedRows = rows.filter((r) => selected.has(r.id));
  // Targets are pre-filtered to eligible rows by runBulk, so each fn is a direct
  // call — no per-job state guard needed (it can never receive an ineligible job).
  const bulkPromote = () =>
    runBulk('Promote', (j) => bq.promoteJob(j.id, j.version), eligibleFor.promote, promoteConfirm);

  const headline = queue
    ? jobsHeadline(queue, status, count)
    : discoveryLoading
      ? 'Discovering queues…'
      : 'Select a queue to see its jobs.';

  return (
    <div>
      <PageHeader
        title="Jobs"
        description={<JobsHeadline text={headline} updatedAt={queue ? updatedAt : null} />}
        actions={
          <>
            <LinkButton to="/job">Find by ID</LinkButton>
            {canOperate && (
              <>
                <LinkButton to="/jobs/bulk-add">Bulk add</LinkButton>
                <LinkButton to="/add-job" variant="primary">
                  <IconPlus className="size-4" /> Add job
                </LinkButton>
              </>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-4">
        {discoveryError && (
          <OfflineBanner
            onRetry={refetchSummary}
            message={
              summary
                ? `Queue inventory refresh failed — showing the last successful queue totals. ${discoveryError.message}`
                : `Could not discover queues — ${discoveryError.message}. Select an existing queue from the URL or retry.`
            }
          />
        )}

        <JobsToolbar
          queue={queue}
          summary={summary ?? []}
          search={search}
          canExport={!!jobs && rows.length > 0}
          onQueue={(next) => {
            setQueue(next);
            resetPage();
            syncUrl(next, status);
          }}
          onSearch={setSearch}
          onExport={() => exportJobs(rows, queue, status)}
        />
        <JobStateTabs
          status={status}
          counts={counts}
          onStatus={(next) => {
            setStatus(next);
            resetPage();
            syncUrl(queue, next);
          }}
        />

        {canOperate && selected.size > 0 && (
          <JobsSelectionBar
            selectedTotal={selected.size}
            selectedVisible={selectedRows.length}
            canPromote={selectedRows.some(eligibleFor.promote)}
            bulkBusy={bulkBusy}
            onPromote={bulkPromote}
            onClear={() => setSelected(new Set())}
          />
        )}

        {actionMsg && (
          <div role="status" className={`text-sm ${actionMsg.ok ? 'text-success' : 'text-danger'}`}>
            {actionMsg.text}
          </div>
        )}

        {error && jobs && (
          <OfflineBanner
            message="Job refresh failed — showing the last successful page."
            onRetry={refetch}
          />
        )}

        {error && !jobs ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : discoveryLoading && !summary && !queue && !discoveryError ? (
          <LoadingState label="Discovering queues…" />
        ) : loading && !jobs ? (
          <LoadingState label="Loading jobs…" />
        ) : (
          <JobsTable
            rows={rows}
            now={updatedAt ?? Date.now()}
            empty={emptyCopy({ search, queue, status, discoveryError: !!discoveryError })}
            selected={selected}
            allSelected={allSelected}
            bulkBusy={bulkBusy}
            busyIds={busyIds}
            footer={footerLabel({
              start: page * JOBS_PAGE_SIZE,
              shown: rows.length,
              onPage: jobs?.length ?? 0,
              total: status === 'all' ? null : count,
              searching: !!term,
            })}
            page={page}
            hasNext={hasNext}
            onToggleAll={toggleAll}
            onToggle={toggle}
            onRun={(...args) => void runOne(...args)}
            onPage={setPage}
          />
        )}
      </div>
    </div>
  );
}
