import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { IconEye, IconJobs, IconPlay } from '@/components/ui/icons';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDuration } from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { JobsFooter } from './JobsFooter';
import { attemptsLabel, createdLabel, previewOf, splitId } from './model';

function EmptyRows({ title, hint, columns }: { title: string; hint: string; columns: number }) {
  return (
    <tr>
      <td colSpan={columns}>
        <div className="flex flex-col items-center gap-1.5 px-4 py-14 text-center">
          <div className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-muted">
            <IconJobs className="size-5" />
          </div>
          <div className="mt-1.5 text-[15px] font-semibold text-fg">{title}</div>
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
  onRun: (job: JobFull, label: string, operation: () => Promise<unknown>) => void;
  onPage: (page: number) => void;
}) {
  // The selection exists for the bulk actions: a viewer has none, so it has no column either.
  const canOperate = useCanOperate();
  return (
    <section
      aria-label="Jobs table"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              {canOperate && (
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    aria-checked={selected.size > 0 && !allSelected ? 'mixed' : allSelected}
                    onChange={onToggleAll}
                    aria-label="Select all jobs on page"
                    className="size-4 accent-ring"
                  />
                </th>
              )}
              <th className="px-4 py-2.5 font-semibold">Job</th>
              <th className="px-4 py-2.5 font-semibold">State</th>
              <th className="px-4 py-2.5 text-right font-semibold">Pri</th>
              <th className="px-4 py-2.5 text-right font-semibold">Attempts</th>
              <th className="px-4 py-2.5 font-semibold">Created</th>
              <th className="px-4 py-2.5 text-right font-semibold">Duration</th>
              {/* relative: keeps the sr-only label inside the scroller instead of the page's overflow */}
              <th className="relative w-24 px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRows {...empty} columns={canOperate ? 8 : 7} />
            ) : (
              rows.map((job) => {
                const { head, tail } = splitId(job.id);
                const preview = previewOf(job);
                const rowBusy = bulkBusy || busyIds.has(job.id);
                return (
                  <tr
                    key={job.id}
                    className={cn(
                      'border-b border-line last:border-0 hover:bg-hover',
                      selected.has(job.id) && 'bg-selected hover:bg-selected'
                    )}
                  >
                    {canOperate && (
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(job.id)}
                          onChange={() => onToggle(job.id)}
                          aria-label={`Select job ${job.id}`}
                          className="size-4 accent-ring"
                        />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <div className="flex max-w-[14rem] min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 font-mono text-[13px] text-fg" title={job.id}>
                          <span className="truncate">{head}</span>
                          <span className="shrink-0">{tail}</span>
                        </span>
                        {preview && <span className="truncate text-xs text-muted">{preview}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={String(job.state ?? 'waiting')} />
                    </td>
                    <td className="px-4 py-2.5 text-right tnum text-muted">{job.priority ?? 0}</td>
                    <td className="px-4 py-2.5 text-right tnum text-muted">{attemptsLabel(job)}</td>
                    <td
                      className="whitespace-nowrap px-4 py-2.5 tnum text-muted"
                      title={formatDateTime(job.createdAt)}
                    >
                      {createdLabel(job.createdAt, now)}
                    </td>
                    <td className="px-4 py-2.5 text-right tnum text-muted">
                      {formatDuration(
                        job.startedAt && job.completedAt
                          ? job.completedAt - job.startedAt
                          : undefined
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Link
                          to={`/job?id=${encodeURIComponent(job.id)}`}
                          aria-label={`Inspect job ${job.id}`}
                          className="inline-flex size-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <IconEye className="size-4" />
                        </Link>
                        {canOperate && actionGates(job.state).promote && (
                          <IconButton
                            aria-label="Promote job"
                            disabled={rowBusy}
                            onClick={() =>
                              onRun(job, 'Promote', () => bq.promoteJob(job.id, job.version))
                            }
                          >
                            <IconPlay className="size-4" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <JobsFooter label={footer} page={page} hasNext={hasNext} onPage={onPage} />
    </section>
  );
}
