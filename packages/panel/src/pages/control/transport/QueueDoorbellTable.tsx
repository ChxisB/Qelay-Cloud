import { cn } from '@/lib/cn';
import { claimableLabel, doorbellVerdict, figure, freshnessLabel, span } from '@/lib/ops/health';
import type { Tone } from '@/lib/ops/health';
import { verdictTone } from '@/lib/ops/health';
import type { TransportQueue } from '@/lib/ops/types';

const DOT: Record<Tone, string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger-fill',
  zinc: 'bg-state-waiting-fg',
};

/**
 * A figure that may be unknown: "unknown" is words and muted, never "0". A broker that counts
 * approximately has its figures marked "≈", so an estimate is not read as an exact count.
 */
function Reading({
  value,
  danger,
  approximate,
}: {
  value: number | null;
  danger?: boolean;
  approximate?: boolean;
}) {
  if (value === null) return <span className="text-faint">unknown</span>;
  return (
    <span
      className={cn(
        'tnum',
        value === 0 && 'text-muted',
        danger && value > 0 && 'font-semibold text-danger'
      )}
      title={approximate ? 'Approximate: the broker counts eventually' : undefined}
    >
      {approximate ? '≈' : ''}
      {figure(value)}
    </span>
  );
}

function Age({ ms }: { ms: number | null }) {
  return ms === null ? (
    <span className="text-faint">unknown</span>
  ) : (
    <span className="tnum">{span(ms)}</span>
  );
}

/**
 * One row per queue. The store's columns come from the database, so they are exact and current;
 * the broker's columns come from a metrics service that lags, so each row says how old they are.
 */
export function QueueDoorbellTable({
  queues,
  lateAfterMs,
  approximate = false,
}: {
  queues: readonly TransportQueue[];
  lateAfterMs: number;
  /** The broker's counts are estimates (SQS): mark them. */
  approximate?: boolean;
}) {
  // A broker that does not count these (Pub/Sub has no in-flight figure) has no column for them.
  const showInFlight = queues.some((queue) => queue.inFlight !== null);
  const showDelayed = queues.some((queue) => queue.delayed !== null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Doorbell health per queue</caption>
        <thead>
          <tr className="border-y border-line text-left eyebrow text-muted">
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Queue
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Claimable
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              No doorbell
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              At broker
            </th>
            {showInFlight && (
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                In flight
              </th>
            )}
            {showDelayed && (
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                Delayed
              </th>
            )}
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Oldest bell
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Dead-letter
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Broker figures
            </th>
          </tr>
        </thead>
        <tbody>
          {queues.map((queue) => {
            const verdict = doorbellVerdict(queue, lateAfterMs);
            const tone = verdictTone(verdict);
            return (
              <tr key={queue.queue} className="border-b border-line align-top last:border-b-0">
                <td className="max-w-[22rem] px-4 py-3.5">
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn('size-2 shrink-0 rounded-full', DOT[tone])}
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium text-fg">{queue.queue}</span>
                  </span>
                  <p className="mt-1 pl-[18px] text-xs text-muted">{verdict.text}</p>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <span className="tnum">{claimableLabel(queue.store)}</span>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Reading value={queue.store.notRung} />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Reading value={queue.doorbellDepth} approximate={approximate} />
                </td>
                {showInFlight && (
                  <td className="px-3 py-3.5 text-right">
                    <Reading value={queue.inFlight} approximate={approximate} />
                  </td>
                )}
                {showDelayed && (
                  <td className="px-3 py-3.5 text-right">
                    <Reading value={queue.delayed} approximate={approximate} />
                  </td>
                )}
                <td className="px-3 py-3.5 text-right">
                  <Age ms={queue.oldestUndeliveredAgeMs} />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Reading value={queue.deadLetterDepth} danger approximate={approximate} />
                  {queue.deadLetterOldestAgeMs !== null && (
                    <span className="block text-xs text-muted">
                      oldest <Age ms={queue.deadLetterOldestAgeMs} />
                    </span>
                  )}
                </td>
                <td className="px-4 py-3.5 text-xs text-muted">{freshnessLabel(queue)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
