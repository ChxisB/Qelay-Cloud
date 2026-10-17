import { Link } from 'react-router-dom';
import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { IconArrowRight } from '@/components/ui/icons';
import { STATE_PILL } from '@/components/ui/StatusBadge';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import type { depthTrend } from '@/lib/useThroughputSeries';

export function RecentQueueJobs({
  name,
  jobs,
  error,
}: {
  name: string;
  jobs: JobFull[];
  error: string | null;
}) {
  return (
    <Card padded={false} className="mb-6">
      <div className="flex items-center justify-between px-5 py-3">
        <h2 className="text-base font-semibold text-fg">Recent jobs</h2>
        <Link
          to={`/jobs?queue=${encodeURIComponent(name)}`}
          className="flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          View all <IconArrowRight className="size-3.5" />
        </Link>
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th className="px-4 py-2.5 font-semibold">ID</th>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">State</th>
              <th className="px-4 py-2.5 text-right font-semibold">Attempts</th>
              <th className="px-4 py-2.5 text-right font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-danger">
                  Could not load recent jobs — {error}. Retry the page.
                </td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-faint">
                  No recent jobs.
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-line last:border-0 hover:bg-surface-2/40"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/job?id=${encodeURIComponent(job.id)}`}
                      className="font-mono text-xs text-link hover:underline"
                    >
                      {job.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">
                    {job.name ?? 'default'}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{job.state ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right tnum text-muted">
                    {job.attempts ?? 0} / {job.maxAttempts ?? '?'}
                  </td>
                  <td className="px-4 py-2.5 text-right tnum text-muted">
                    {formatDuration(
                      job.startedAt && job.completedAt ? job.completedAt - job.startedAt : undefined
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PriorityHistogram({ counts }: { counts: Record<string, number> }) {
  const rows = Object.entries(counts ?? {})
    .map(([priority, count]) => [Number(priority), count] as const)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[0] - left[0]);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map(([, count]) => count));
  return (
    <Card className="mb-6">
      <CardHeader title="Jobs by priority" />
      <div className="flex flex-col gap-2">
        {rows.map(([priority, count]) => (
          <div key={priority} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">
              p{priority}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-surface-2">
              <div
                className="h-full rounded bg-state-prioritized-fg"
                style={{ width: `${Math.max(2, (count / max) * 100)}%` }}
              />
            </div>
            <span className="w-14 shrink-0 tnum text-xs text-fg">{formatNumber(count)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">Higher p = higher priority. Waiting jobs only.</p>
    </Card>
  );
}

export function BacklogDepthCard({
  name,
  depth,
  trend,
  rate,
}: {
  name: string;
  depth: number[];
  trend: ReturnType<typeof depthTrend>;
  rate: number | null;
}) {
  return (
    <Card className="mb-6">
      <CardHeader
        title="Backlog depth"
        action={
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              trend.draining
                ? STATE_PILL.completed
                : trend.label === 'accumulating'
                  ? STATE_PILL.failed
                  : 'bg-surface-2 text-muted'
            )}
          >
            {trend.label}
          </span>
        }
      />
      {depth.length < 2 ? (
        <p className="py-6 text-center text-xs text-faint">
          Sampling… the backlog trend appears after a few polls.
        </p>
      ) : (
        <AreaChart
          height={140}
          ariaLabel={`${name} backlog depth`}
          series={[
            {
              label: 'depth',
              color: trend.draining ? 'var(--state-completed-fg)' : 'var(--state-delayed-fg)',
              points: depth,
              area: true,
            },
          ]}
        />
      )}
      <div className="mt-1 flex items-center justify-between text-xs text-faint">
        <span>waiting + prioritized + active + delayed + waiting-children</span>
        <span className="tnum">Error rate {rate == null ? '—' : formatPercent(rate)}</span>
      </div>
    </Card>
  );
}
