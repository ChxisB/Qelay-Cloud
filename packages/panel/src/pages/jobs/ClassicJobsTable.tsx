import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatDuration, formatRelativeTime, jobDuration } from '@/lib/format';
import type { Job } from '@/lib/types';
import { jobDataName } from './classicJobsData';

export function ClassicJobsTable({ rows, emptyMessage }: { rows: Job[]; emptyMessage: string }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
            <th className="px-4 py-2.5 font-semibold">Job ID</th>
            <th className="px-4 py-2.5 font-semibold">Name</th>
            <th className="px-4 py-2.5 font-semibold">Queue</th>
            <th className="px-4 py-2.5 font-semibold">Status</th>
            <th className="px-4 py-2.5 text-right font-semibold">Priority</th>
            <th className="px-4 py-2.5 text-right font-semibold">Created</th>
            <th className="px-4 py-2.5 text-right font-semibold">Duration</th>
            <th className="w-12 px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center text-sm text-faint">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((job) => (
              <tr
                key={`${job.queue}:${job.id}`}
                className="border-b border-line last:border-0 hover:bg-surface-2/40"
              >
                <td className="px-4 py-2.5 font-mono text-xs">
                  <Link
                    to={`/job?id=${encodeURIComponent(job.id)}`}
                    className="text-link hover:text-link hover:underline"
                    title={`Inspect job ${job.id}`}
                  >
                    {job.id}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-fg">
                  {job.name ?? jobDataName(job.data) ?? 'default'}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">{job.queue}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={String(job.state ?? job.status ?? 'waiting')} />
                </td>
                <td className="px-4 py-2.5 text-right tnum text-muted">{job.priority ?? 0}</td>
                <td className="px-4 py-2.5 text-right text-faint">
                  {formatRelativeTime(job.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-right tnum text-muted">
                  {formatDuration(
                    jobDuration(job.startedAt ?? undefined, job.completedAt ?? undefined)
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="text-xs text-faint" title={FLOW_DELETION_UNAVAILABLE}>
                    Delete unavailable
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
