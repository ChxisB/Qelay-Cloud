import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { IconArrowRight, IconPause, IconPlay, IconQueues } from '@/components/ui/icons';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

export const SORT_COLS = [
  ['waiting', 'Waiting'],
  ['prioritized', 'Prioritized'],
  ['active', 'Active'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['delayed', 'Delayed'],
] as const;
export type QueueSortKey = (typeof SORT_COLS)[number][0];

export function QueuesTable({
  rows,
  hasData,
  error,
  search,
  sortCol,
  sortDir,
  bulkBusy,
  busy,
  canOperate,
  onSort,
  onToggle,
}: {
  rows: QueueSummaryFull[];
  hasData: boolean;
  error: Error | null;
  search: string;
  sortCol: QueueSortKey | null;
  sortDir: 'desc' | 'asc';
  bulkBusy: boolean;
  busy: Set<string>;
  /** A viewer sees the queues but not the pause and resume controls. */
  canOperate: boolean;
  onSort: (key: QueueSortKey) => void;
  onToggle: (queue: QueueSummaryFull) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
            <th className="px-4 py-2.5 font-semibold">Queue</th>
            {SORT_COLS.map(([key, label]) => (
              <th
                key={key}
                aria-sort={
                  sortCol === key ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined
                }
                className="px-4 py-2.5 text-right font-semibold"
              >
                <button
                  type="button"
                  onClick={() => onSort(key)}
                  className="inline-flex items-center gap-1 rounded uppercase hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {label}
                  {sortCol === key && (
                    <span aria-hidden="true">{sortDir === 'desc' ? '↓' : '↑'}</span>
                  )}
                </button>
              </th>
            ))}
            <th className="px-4 py-2.5 font-semibold">Status</th>
            <th className="w-24 px-4 py-2.5 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {!hasData && error ? (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-sm text-warning">
                Could not load queues — {error.message}. Retry above.
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-sm text-faint">
                {search ? 'No queues match your search.' : 'No queues yet.'}
              </td>
            </tr>
          ) : (
            rows.map((queue) => {
              const rowBusy = bulkBusy || busy.has(queue.name);
              return (
                <tr
                  key={queue.name}
                  className="group border-b border-line last:border-0 transition-colors hover:bg-surface-2/50"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/queues/${encodeURIComponent(queue.name)}`}
                      className="flex items-center gap-2 rounded font-medium text-fg hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <IconQueues className="size-4 text-faint" />
                      {queue.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-state-waiting-fg">
                    {formatNumber(queue.counts.waiting)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-fg">
                    {formatNumber(queue.counts.prioritized)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-state-active-fg">
                    {formatNumber(queue.counts.active)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-success">
                    {formatNumber(queue.counts.completed)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-2.5 text-right tnum',
                      queue.counts.failed ? 'text-danger' : 'text-muted'
                    )}
                  >
                    {formatNumber(queue.counts.failed)}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-muted">
                    {formatNumber(queue.counts.delayed)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                        queue.paused
                          ? 'bg-state-waiting-bg text-state-waiting-fg'
                          : 'bg-state-completed-bg text-state-completed-fg'
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {queue.paused ? 'Paused' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {canOperate && (
                        <IconButton
                          aria-label={queue.paused ? 'Resume queue' : 'Pause queue'}
                          disabled={rowBusy}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggle(queue);
                          }}
                        >
                          {queue.paused ? (
                            <IconPlay className="size-3.5 text-success" />
                          ) : (
                            <IconPause className="size-3.5 text-warning" />
                          )}
                        </IconButton>
                      )}
                      <IconArrowRight className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
