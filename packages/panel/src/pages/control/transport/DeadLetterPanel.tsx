import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { api } from '@/lib/api';
import { span } from '@/lib/ops/health';
import type { DeadLettersView } from '@/lib/ops/types';
import { usePolledData } from '@/lib/usePolledData';

const REASON: Record<NonNullable<DeadLettersView['reason']>, string> = {
  not_supported: 'This queue service does not keep a list of failed notifications.',
  unreachable:
    'The queue service could not be read, so its failed notifications are unknown (not none).',
};

function Samples({ queue }: { queue: string }) {
  const { data, error, loading, refetch } = usePolledData(
    () => api.transportDeadLetters(queue, 25),
    [queue],
    // Pulling from a broker is not free: read on demand and on a slow beat, not every few seconds.
    { intervalMs: 60_000 }
  );
  if (loading && !data && !error) return <LoadingState label="Reading failed notifications…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  if (!data.available) {
    return <p className="text-[13px] text-muted">{REASON[data.reason ?? 'unreachable']}</p>;
  }
  if (data.items.length === 0) {
    return <p className="text-[13px] text-muted">No failed notifications in {queue}.</p>;
  }
  // A job can be dead-lettered twice and an undecodable bell has no id: number repeats of a key.
  const seen = new Map<string, number>();
  const rows = data.items.map((item) => {
    const base = item.jobId ?? 'undecodable';
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return { item, key: `${base}#${nth}` };
  });
  return (
    <div>
      <TableScroll className="rounded-card border border-line">
        <Table className="min-w-[480px]">
          <caption className="sr-only">Failed notifications of {queue}</caption>
          <THead>
            <tr>
              <Th>Job</Th>
              <Th right>Attempts</Th>
              <Th right>Gave up</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map(({ item, key }) => (
              <Tr key={key} dense>
                <Td className="font-mono text-[13px]">
                  {item.jobId === null ? (
                    <span className="text-faint">unreadable notification</span>
                  ) : item.jobExists ? (
                    <Link
                      className="font-semibold text-link underline underline-offset-2"
                      to={`/job?id=${encodeURIComponent(item.jobId)}`}
                    >
                      {item.jobId}
                    </Link>
                  ) : (
                    <span title="The job no longer exists">{item.jobId}</span>
                  )}
                </Td>
                <Td className="tnum text-right">
                  {item.deliveryCount === null ? (
                    <span className="text-faint">unknown</span>
                  ) : (
                    item.deliveryCount
                  )}
                </Td>
                <Td className="text-right text-muted">
                  {item.ageMs === null ? 'unknown' : `${span(item.ageMs)} ago`}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      <p className="mt-3 text-[13px] text-muted">
        A sample of at most 25, read without removing them: not a count and not an order.
      </p>
    </div>
  );
}

/**
 * Recent poison doorbells of one queue, read-only. Redriving them is a manual runbook step, not a
 * button: the job is still in the database and the tick rings it again on its own schedule.
 */
export function DeadLetterPanel({
  queues,
  supported,
  canOperate,
}: {
  queues: readonly string[];
  supported: boolean;
  canOperate: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const queue = chosen !== null && queues.includes(chosen) ? chosen : (queues[0] ?? null);
  return (
    <Card>
      <CardHeader
        title="Failed notifications"
        sub="Recent notifications the queue service gave up delivering, read without removing them."
      />
      {!supported ? (
        <p className="text-[13px] text-muted">
          This queue service does not keep a list of failed notifications. A job that runs out of
          attempts fails in the database and is listed under Dead Letter Queue.
        </p>
      ) : !canOperate ? (
        <p className="text-[13px] text-muted">
          Listing failed notifications reads from the queue service and names job ids, so it is for
          operators. The number for each queue is in the table above.
        </p>
      ) : queue === null ? (
        <p className="text-[13px] text-muted">No queue to read.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex max-w-xs flex-col gap-2 text-[13px] font-bold text-fg">
            Queue
            <Select value={queue} onChange={(event) => setChosen(event.target.value)}>
              {queues.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
          <Samples queue={queue} />
          <p className="text-[13px] text-muted">
            Read-only. To send failed notifications again, follow the redrive runbook; the page does
            not do it for you.
          </p>
        </div>
      )}
    </Card>
  );
}
