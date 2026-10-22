import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { Figure } from '@/components/ui/Figure';
import { IconArrowRight, IconPause, IconPlay, IconQueues } from '@/components/ui/icons';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { useFirstLoad } from '@/lib/useFirstLoad';

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
  // The rows of the first load rise in a stagger; a row a poll adds later does not.
  const first = useFirstLoad(rows.length > 0);
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table>
        <THead>
          <tr>
            <Th>Queue</Th>
            {SORT_COLS.map(([key, label]) => (
              <Th
                key={key}
                aria-sort={
                  sortCol === key ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined
                }
                className="text-right"
              >
                <button
                  type="button"
                  onClick={() => onSort(key)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-[8px] uppercase hover:text-fg"
                >
                  {label}
                  {sortCol === key && (
                    <span aria-hidden="true">{sortDir === 'desc' ? '↓' : '↑'}</span>
                  )}
                </button>
              </Th>
            ))}
            <Th>Status</Th>
            <Th right className="w-24">
              Actions
            </Th>
          </tr>
        </THead>
        <tbody>
          {!hasData && error ? (
            <tr>
              <Td colSpan={9} className="py-12 text-center text-sm text-warning">
                Could not load queues — {error.message}. Retry above.
              </Td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <Td colSpan={9} className="py-12 text-center text-sm text-faint">
                {search ? 'No queues match your search.' : 'No queues yet.'}
              </Td>
            </tr>
          ) : (
            rows.map((queue, index) => {
              const rowBusy = bulkBusy || busy.has(queue.name);
              // A failure outranks a pause: the bar is for what needs a person.
              const bar = queue.counts.failed ? 'bad' : queue.paused ? 'idle' : undefined;
              return (
                <Tr
                  key={queue.name}
                  status={bar}
                  arrive={first ? index : undefined}
                  className="group"
                >
                  <Td>
                    <Link
                      to={`/queues/${encodeURIComponent(queue.name)}`}
                      className="flex items-center gap-2 rounded-[8px] font-bold text-fg hover:text-link"
                    >
                      <IconQueues className="size-4 text-faint" />
                      {queue.name}
                    </Link>
                  </Td>
                  <Td className="text-right tnum text-state-waiting-fg">
                    <Figure value={queue.counts.waiting} />
                  </Td>
                  <Td className="text-right tnum">
                    <Figure value={queue.counts.prioritized} />
                  </Td>
                  <Td className="text-right tnum text-state-active-fg">
                    <Figure value={queue.counts.active} />
                  </Td>
                  <Td className="text-right tnum text-success">
                    <Figure value={queue.counts.completed} />
                  </Td>
                  <Td
                    className={cn(
                      'text-right tnum',
                      queue.counts.failed ? 'font-bold text-danger' : 'text-muted'
                    )}
                  >
                    <Figure value={queue.counts.failed} />
                  </Td>
                  <Td className="text-right tnum text-muted">
                    <Figure value={queue.counts.delayed} />
                  </Td>
                  <Td>
                    <StatusPill state={queue.paused ? 'waiting' : 'active'}>
                      {queue.paused ? 'Paused' : 'Active'}
                    </StatusPill>
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      {canOperate && (
                        <IconButton
                          aria-label={`${queue.paused ? 'Resume' : 'Pause'} queue, ${queue.name}`}
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
                  </Td>
                </Tr>
              );
            })
          )}
        </tbody>
      </Table>
    </TableScroll>
  );
}
