import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { span } from '@/lib/ops/health';
import type { DeadLettersView } from '@/lib/ops/types';
import { usePolledData } from '@/lib/usePolledData';

const REASON: Record<NonNullable<DeadLettersView['reason']>, string> = {
  not_supported: 'This transport has no dead-letter queue of doorbells.',
  unreachable: 'The broker could not be read, so its dead-letter queue is unknown (not empty).',
};

function Samples({ queue }: { queue: string }) {
  const { data, error, loading, refetch } = usePolledData(
    () => api.transportDeadLetters(queue, 25),
    [queue],
    // Pulling from a broker is not free: read on demand and on a slow beat, not every few seconds.
    { intervalMs: 60_000 }
  );
  if (loading && !data && !error) return <LoadingState label="Reading the dead-letter queue…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  if (!data.available) {
    return <p className="text-sm text-muted">{REASON[data.reason ?? 'unreachable']}</p>;
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-muted">No poison doorbells in {queue}.</p>;
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Poison doorbells of {queue}</caption>
        <thead>
          <tr className="border-y border-line text-left eyebrow text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">
              Job
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Deliveries
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Dead-lettered
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, key }) => (
            <tr key={key} className="border-b border-line last:border-b-0">
              <td className="px-3 py-2.5 font-mono text-xs">
                {item.jobId === null ? (
                  <span className="text-faint">undecodable bell</span>
                ) : item.jobExists ? (
                  <Link
                    className="text-primary underline"
                    to={`/job?id=${encodeURIComponent(item.jobId)}`}
                  >
                    {item.jobId}
                  </Link>
                ) : (
                  <span title="The job no longer exists">{item.jobId}</span>
                )}
              </td>
              <td className="tnum px-3 py-2.5 text-right">
                {item.deliveryCount === null ? (
                  <span className="text-faint">unknown</span>
                ) : (
                  item.deliveryCount
                )}
              </td>
              <td className="px-3 py-2.5 text-right text-muted">
                {item.ageMs === null ? 'unknown' : `${span(item.ageMs)} ago`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted">
        A sample of at most 25, read without consuming them: not a count and not an order.
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
      <CardHeader title="Poison doorbells" />
      {!supported ? (
        <p className="text-sm text-muted">
          This transport has no dead-letter queue of doorbells. A job that exhausts its attempts
          fails in the database and is listed under Dead Letter Queue.
        </p>
      ) : !canOperate ? (
        <p className="text-sm text-muted">
          Listing poison doorbells reads from the broker and names job ids, so it is for operators.
          The depth of each queue's dead-letter queue is in the table above.
        </p>
      ) : queue === null ? (
        <p className="text-sm text-muted">No queue to read.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm text-muted">
            Queue
            <select
              className="h-9 rounded-control border border-line-strong bg-surface px-2 text-fg"
              value={queue}
              onChange={(event) => setChosen(event.target.value)}
            >
              {queues.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <Samples queue={queue} />
          <p className="text-xs text-muted">
            Read-only. To redrive poison doorbells, follow the redrive runbook; the page does not do
            it for you.
          </p>
        </div>
      )}
    </Card>
  );
}
