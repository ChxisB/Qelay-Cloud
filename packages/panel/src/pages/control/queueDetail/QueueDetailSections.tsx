import { Link } from 'react-router-dom';
import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { IconArrowRight } from '@/components/ui/icons';
import { StatusBadge, StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { JobFull } from '@/lib/bqTypes';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';
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
  // The jobs of the first load rise in a stagger; one a poll adds later does not.
  const first = useFirstLoad(jobs.length > 0);
  return (
    <Card padded={false} className="mb-6">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-base font-semibold text-fg">Recent jobs</h2>
        <Link
          to={`/jobs?queue=${encodeURIComponent(name)}`}
          className="flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          View all <IconArrowRight className="size-3.5" />
        </Link>
      </div>
      <TableScroll className="border-t border-line">
        <Table>
          <THead>
            <tr>
              <Th>ID</Th>
              <Th>Name</Th>
              <Th>State</Th>
              <Th right>Attempts</Th>
              <Th right>Duration</Th>
            </tr>
          </THead>
          <tbody>
            {error ? (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-sm text-danger">
                  Could not load recent jobs — {error}. Retry the page.
                </Td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-sm text-faint">
                  No recent jobs.
                </Td>
              </tr>
            ) : (
              jobs.map((job, index) => (
                <Tr
                  key={job.id}
                  status={job.state === 'failed' ? 'bad' : undefined}
                  arrive={first ? index : undefined}
                >
                  <Td>
                    <Link
                      to={`/job?id=${encodeURIComponent(job.id)}`}
                      className="font-mono text-xs text-link hover:underline"
                    >
                      {job.id}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs text-muted">{job.name ?? 'default'}</Td>
                  <Td>{job.state ? <StatusBadge status={job.state} /> : '—'}</Td>
                  <Td className="text-right tnum text-muted">
                    {job.attempts ?? 0} / {job.maxAttempts ?? '?'}
                  </Td>
                  <Td className="text-right tnum text-muted">
                    {formatDuration(
                      job.startedAt && job.completedAt ? job.completedAt - job.startedAt : undefined
                    )}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </TableScroll>
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
                className="motion-fill h-full rounded bg-state-prioritized-fg"
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
          <StatusPill
            state={
              trend.draining ? 'completed' : trend.label === 'accumulating' ? 'failed' : 'waiting'
            }
          >
            {trend.label}
          </StatusPill>
        }
      />
      {depth.length < 2 ? (
        <p className="py-4 text-center text-xs text-faint">
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
