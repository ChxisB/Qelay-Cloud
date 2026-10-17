import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconQueues } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SearchField } from '@/components/ui/SearchField';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { QueuesResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 20;
const EMPTY: QueuesResponse = {
  ok: false,
  queues: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  timestamp: 0,
};

export function Queues() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const { data, error, loading, refetch } = usePolledData(
    () => api.queues(PAGE_SIZE, page * PAGE_SIZE),
    [page]
  );
  const { data: overview } = usePolledData(() => api.overview(), []);

  const d = data ?? EMPTY;

  const queues = useMemo(() => {
    const all = d.queues;
    const term = search.trim().toLowerCase();
    return term ? all.filter((q) => q.name.toLowerCase().includes(term)) : all;
  }, [d, search]);

  if (loading && !data && !error) return <LoadingState label="Loading queues…" />;

  const totals = overview?.stats;

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader
        title="Queues"
        description={data ? `${d.total} queues` : 'Queue inventory unavailable'}
        live={!!data && !error}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Waiting"
          value={totals ? formatNumber(totals.waiting) : '—'}
          tone="waiting"
          compact
        />
        <StatCard
          label="Active"
          value={totals ? formatNumber(totals.active) : '—'}
          tone="active"
          compact
        />
        <StatCard
          label="Delayed"
          value={totals ? formatNumber(totals.delayed) : '—'}
          tone="default"
          compact
        />
        <StatCard
          label="DLQ"
          value={totals ? formatNumber(totals.dlq) : '—'}
          tone={totals?.dlq ? 'red' : 'default'}
          compact
        />
      </div>

      <SearchField
        containerClassName="mb-4 max-w-sm"
        aria-label="Filter queues"
        name="classic-queue-filter"
        autoComplete="off"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search queues…"
      />

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th className="px-4 py-2.5 font-semibold">Queue</th>
              <th className="px-4 py-2.5 text-right font-semibold">Waiting</th>
              <th className="px-4 py-2.5 text-right font-semibold">Active</th>
              <th className="px-4 py-2.5 text-right font-semibold">Delayed</th>
              <th className="px-4 py-2.5 text-right font-semibold">DLQ</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="w-10 px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {!data && error ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-warning">
                  Could not load queues — {error.message}. Retry above.
                </td>
              </tr>
            ) : queues.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-faint">
                  {search ? 'No queues match on this page.' : 'No queues yet.'}
                </td>
              </tr>
            ) : (
              queues.map((qd) => (
                <tr
                  key={qd.name}
                  className="group border-b border-line last:border-0 transition-colors hover:bg-surface-2/50"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/queues-classic/${encodeURIComponent(qd.name)}`}
                      className="flex items-center gap-2 rounded font-medium text-fg hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <IconQueues className="size-4 text-faint" />
                      {qd.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-muted">
                    {formatNumber(qd.waiting)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-state-active-fg">
                    {formatNumber(qd.active)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-muted">
                    {formatNumber(qd.delayed)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-2.5 text-right tnum',
                      qd.dlq ? 'text-danger' : 'text-muted'
                    )}
                  >
                    {formatNumber(qd.dlq)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                        qd.paused
                          ? 'bg-state-waiting-bg text-state-waiting-fg'
                          : 'bg-state-completed-bg text-state-completed-fg'
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {qd.paused ? 'Paused' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-faint">
                    <IconArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={d.total}
          onPageChange={setPage}
          label="queues"
        />
      )}
    </div>
  );
}
