import { Link } from 'react-router-dom';
import type { ConfirmOptions } from '@/components/dashboard/stores/confirmStore';
import { iconButtonClass, IconButton } from '@/components/ui/Button';
import { IconEye, IconJobs, IconPlay } from '@/components/ui/icons';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatDateTime, formatDuration } from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { JobsFooter } from './JobsFooter';
import { attemptsLabel, createdLabel, previewOf, splitId } from './model';
import { promoteConfirm } from './promoteConfirm';

function EmptyRows({ title, hint, columns }: { title: string; hint: string; columns: number }) {
  return (
    <tr>
      <td colSpan={columns}>
        <div className="flex flex-col items-center gap-1.5 px-4 py-14 text-center">
          <div className="flex size-8 items-center justify-center rounded-control bg-slate-tint text-muted">
            <IconJobs className="size-5" />
          </div>
          <div className="mt-1.5 text-[13px] font-bold text-fg">{title}</div>
          <div className="text-[13px] text-muted">{hint}</div>
        </div>
      </td>
    </tr>
  );
}

export function JobsTable({
  rows,
  now,
  empty,
  selected,
  allSelected,
  bulkBusy,
  busyIds,
  footer,
  page,
  hasNext,
  onToggleAll,
  onToggle,
  onRun,
  onPage,
}: {
  rows: JobFull[];
  now: number;
  /** What to say when there are no rows to show. */
  empty: { title: string; hint: string };
  selected: Set<string>;
  allSelected: boolean;
  bulkBusy: boolean;
  busyIds: Set<string>;
  footer: string;
  page: number;
  hasNext: boolean;
  onToggleAll: () => void;
  onToggle: (id: string) => void;
  onRun: (
    job: JobFull,
    label: string,
    operation: () => Promise<unknown>,
    confirm?: ConfirmOptions
  ) => void;
  onPage: (page: number) => void;
}) {
  // The selection exists for the bulk actions: a viewer has none, so it has no column either.
  const canOperate = useCanOperate();
  // The rows of the first load rise in a stagger; a row a poll adds later does not.
  const first = useFirstLoad(rows.length > 0);
  return (
    <section
      aria-label="Jobs table"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <TableScroll>
        <Table className="min-w-[700px]">
          <THead>
            <tr>
              {canOperate && (
                <Th className="w-12">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    aria-checked={selected.size > 0 && !allSelected ? 'mixed' : allSelected}
                    onChange={onToggleAll}
                    aria-label="Select all jobs on this page"
                    className="size-[18px] accent-hl"
                  />
                </Th>
              )}
              <Th>Job</Th>
              <Th>State</Th>
              <Th right>Pri</Th>
              <Th right>Attempts</Th>
              <Th>Created</Th>
              <Th right>Duration</Th>
              {/* relative: keeps the sr-only label inside the scroller instead of the page's overflow */}
              <Th className="relative w-24">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRows {...empty} columns={canOperate ? 8 : 7} />
            ) : (
              rows.map((job, index) => {
                const { head, tail } = splitId(job.id);
                const preview = previewOf(job);
                const rowBusy = bulkBusy || busyIds.has(job.id);
                return (
                  <Tr
                    key={job.id}
                    arrive={first ? index : undefined}
                    selected={selected.has(job.id)}
                    status={job.state === 'failed' ? 'bad' : undefined}
                  >
                    {canOperate && (
                      <Td>
                        <input
                          type="checkbox"
                          checked={selected.has(job.id)}
                          onChange={() => onToggle(job.id)}
                          aria-label={`Select job ${tail}`}
                          className="size-[18px] accent-hl"
                        />
                      </Td>
                    )}
                    <Td>
                      <div className="flex max-w-[14rem] min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 font-mono text-[13px] text-fg" title={job.id}>
                          <span className="truncate">{head}</span>
                          <span className="shrink-0">{tail}</span>
                        </span>
                        {preview && <span className="truncate text-xs text-muted">{preview}</span>}
                      </div>
                    </Td>
                    <Td>
                      <StatusBadge status={String(job.state ?? 'waiting')} />
                    </Td>
                    <Td className="text-right tnum text-muted">{job.priority ?? 0}</Td>
                    <Td className="text-right tnum text-muted">{attemptsLabel(job)}</Td>
                    <Td
                      className="whitespace-nowrap tnum text-muted"
                      title={formatDateTime(job.createdAt)}
                    >
                      {createdLabel(job.createdAt, now)}
                    </Td>
                    <Td className="text-right tnum text-muted">
                      {formatDuration(
                        job.startedAt && job.completedAt
                          ? job.completedAt - job.startedAt
                          : undefined
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        <Link
                          to={`/job?id=${encodeURIComponent(job.id)}`}
                          aria-label={`Inspect job ${tail}`}
                          className={iconButtonClass('ghost', 'sm')}
                        >
                          <IconEye className="size-4" />
                        </Link>
                        {canOperate && actionGates(job.state).promote && (
                          <IconButton
                            size="sm"
                            aria-label={`Promote job ${tail}`}
                            disabled={rowBusy}
                            onClick={() =>
                              onRun(
                                job,
                                'Promote',
                                () => bq.promoteJob(job.id, job.version),
                                promoteConfirm(1)
                              )
                            }
                          >
                            <IconPlay className="size-4" />
                          </IconButton>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })
            )}
          </tbody>
        </Table>
      </TableScroll>
      <JobsFooter label={footer} page={page} hasNext={hasNext} onPage={onPage} />
    </section>
  );
}
