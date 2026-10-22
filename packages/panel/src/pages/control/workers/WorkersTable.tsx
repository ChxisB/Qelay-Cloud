import { IconButton } from '@/components/ui/Button';
import { Figure } from '@/components/ui/Figure';
import { IconTrash } from '@/components/ui/icons';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { useLeavers } from '@/lib/useLeavers';
import { SortButton } from './SortButton';

export const STALE_EXPLAINER = 'No heartbeat recently — derived from lastSeen';

export type SortKey = 'failed' | 'lastSeen';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export interface WorkerRow {
  id: string;
  name?: string;
  queues: string[];
  status: string;
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
  lastSeen: number;
}

const ariaSort = (sort: Sort | null, key: SortKey) =>
  sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;

export function WorkersTable({
  rows,
  canOperate,
  sort,
  onSort,
  busyIds,
  onRemove,
}: {
  rows: WorkerRow[];
  canOperate: boolean;
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  busyIds: Set<string>;
  onRemove: (id: string) => void;
}) {
  const first = useFirstLoad(rows.length > 0);
  const shown = useLeavers(rows);
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table className="min-w-[720px]">
        <THead>
          <tr>
            <Th>Worker</Th>
            <Th>Queues</Th>
            <Th>Status</Th>
            <Th right>Active</Th>
            <Th right>Processed</Th>
            <Th right aria-sort={ariaSort(sort, 'failed')}>
              <SortButton
                label="Failed"
                active={sort?.key === 'failed' ? sort.dir : null}
                onClick={() => onSort('failed')}
              />
            </Th>
            <Th right aria-sort={ariaSort(sort, 'lastSeen')}>
              <SortButton
                label="Last seen"
                active={sort?.key === 'lastSeen' ? sort.dir : null}
                onClick={() => onSort('lastSeen')}
              />
            </Th>
            {canOperate && (
              <Th right className="w-16">
                Actions
              </Th>
            )}
          </tr>
        </THead>
        <tbody>
          {shown.map(({ item: w, leaving }, index) => {
            const stale = w.status !== 'active';
            return (
              <Tr
                key={w.id}
                status={stale ? 'warn' : undefined}
                arrive={first && !leaving ? index : undefined}
                inert={leaving}
                className={cn(leaving && 'motion-leave')}
              >
                <Td>
                  <div className="font-bold">{w.name || 'worker'}</div>
                  <div className="font-mono text-[12px] text-faint">{w.id}</div>
                </Td>
                <Td className="font-mono text-xs text-muted">{w.queues.join(', ') || '—'}</Td>
                <Td>
                  <span title={stale ? STALE_EXPLAINER : undefined}>
                    <StatusPill state={stale ? 'delayed' : 'active'}>{w.status}</StatusPill>
                  </span>
                </Td>
                <Td className="text-right tnum text-state-active-fg">
                  <Figure value={w.activeJobs} />
                </Td>
                <Td className="text-right tnum text-muted">
                  <Figure value={w.processedJobs} />
                </Td>
                <Td className="text-right tnum text-muted">
                  <Figure value={w.failedJobs} />
                </Td>
                <Td className="text-right text-muted">{formatRelativeTime(w.lastSeen)}</Td>
                {canOperate && (
                  <Td>
                    <div className="flex justify-end">
                      {w.status === 'stale' && w.activeJobs === 0 ? (
                        <IconButton
                          aria-label={`Remove stale registry record for worker ${w.id}`}
                          title="Registry cleanup only — does not stop the worker process"
                          disabled={busyIds.has(w.id)}
                          onClick={() => onRemove(w.id)}
                        >
                          <IconTrash className="size-3.5" />
                        </IconButton>
                      ) : (
                        <span
                          className="text-xs text-faint"
                          title={
                            w.status === 'stale'
                              ? 'Registry cleanup is blocked while active jobs are reported'
                              : 'Only stale, idle registry records can be removed'
                          }
                        >
                          —
                        </span>
                      )}
                    </div>
                  </Td>
                )}
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
