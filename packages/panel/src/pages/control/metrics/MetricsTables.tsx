import { Card, CardHeader } from '@/components/ui/Card';
import { Figure } from '@/components/ui/Figure';
import { Pagination } from '@/components/ui/Pagination';
import { StatusGlyph, StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import type { useThroughputSeries } from '@/lib/useThroughputSeries';

const OPS = ['push', 'pull', 'ack'] as const;
const P99_WARN_MS = 100;

export function OperationLatency({
  latency,
}: {
  latency: NonNullable<ReturnType<typeof useThroughputSeries>['latest']>['latency'] | undefined;
}) {
  return (
    <Card className="mb-6" padded={false}>
      <div className="px-4 pt-6">
        <CardHeader
          title="Operation latency"
          sub="TCP round trip per operation, in milliseconds (average, p50, p95, p99)"
        />
      </div>
      <TableScroll>
        <Table>
          <THead>
            <tr>
              <Th>Operation</Th>
              <Th right>Avg</Th>
              <Th right>p50</Th>
              <Th right>p95</Th>
              <Th right>p99</Th>
            </tr>
          </THead>
          <tbody>
            {OPS.map((operation) => {
              const percentile = latency?.percentiles?.[operation];
              const average = latency?.averages?.[`${operation}Ms`];
              const slow = (percentile?.p99 ?? 0) > P99_WARN_MS;
              return (
                <Tr key={operation} dense status={slow ? 'warn' : undefined}>
                  <Td className="font-bold capitalize">{operation}</Td>
                  <Td className="text-right tnum text-muted">{formatMs(average)}</Td>
                  <Td className="text-right tnum text-muted">{formatMs(percentile?.p50)}</Td>
                  <Td className="text-right tnum text-muted">{formatMs(percentile?.p95)}</Td>
                  <Td
                    className={cn(
                      'text-right tnum',
                      slow ? 'font-bold text-warning' : 'text-muted'
                    )}
                  >
                    {slow ? (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <StatusGlyph state="delayed" small />
                        slow {formatMs(percentile?.p99)}
                      </span>
                    ) : (
                      formatMs(percentile?.p99)
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
    </Card>
  );
}

export function PerQueueMetrics({
  rows,
  total,
  page,
  pageSize,
  onPage,
  empty,
}: {
  rows: QueueSummaryFull[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  empty: string;
}) {
  return (
    <Card padded={false}>
      <div className="px-4 pt-6">
        <CardHeader title="Per-queue metrics" sub="Job counts for each queue" />
      </div>
      <TableScroll>
        <Table className="min-w-[640px]">
          <THead>
            <tr>
              <Th>Queue</Th>
              <Th>Status</Th>
              <Th right>Waiting</Th>
              <Th right>Prioritized</Th>
              <Th right>Active</Th>
              <Th right>Completed</Th>
              <Th right>Failed</Th>
            </tr>
          </THead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((queue) => (
                <Tr key={queue.name} dense>
                  <Td className="font-mono text-xs font-bold">{queue.name}</Td>
                  <Td>
                    <StatusPill state={queue.paused ? 'waiting' : 'active'}>
                      {queue.paused ? 'paused' : 'active'}
                    </StatusPill>
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
                      queue.counts.failed > 0 && 'font-bold text-danger'
                    )}
                  >
                    <Figure value={queue.counts.failed} />
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </TableScroll>
      <div className="px-4 pb-5">
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPage}
          label="queues"
        />
      </div>
    </Card>
  );
}

function formatMs(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}ms`;
}
