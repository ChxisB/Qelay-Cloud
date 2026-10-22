import { StatusPill, type StateRole } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr, type RowStatus } from '@/components/ui/Table';
import { Wash } from '@/components/ui/Wash';
import { cn } from '@/lib/cn';
import {
  claimableLabel,
  doorbellVerdict,
  figure,
  freshnessLabel,
  span,
  verdictTone,
  type DoorbellVerdict,
} from '@/lib/ops/health';
import type { TransportQueue } from '@/lib/ops/types';
import { useFirstLoad } from '@/lib/useFirstLoad';

/** A verdict is a word and a glyph as well as a row bar, so no reading rests on colour. */
const VERDICT: Record<DoorbellVerdict['kind'], { state: StateRole; word: string }> = {
  ok: { state: 'completed', word: 'Normal' },
  backlog: { state: 'waiting', word: 'Backlog' },
  held: { state: 'waiting', word: 'Paused' },
  unknown: { state: 'waiting', word: 'Unknown' },
  'tick-behind': { state: 'delayed', word: 'Maintenance behind' },
  poison: { state: 'failed', word: 'Delivery failed' },
};

const ROW_BAR: Partial<Record<ReturnType<typeof verdictTone>, RowStatus>> = {
  red: 'bad',
  amber: 'warn',
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
        danger && value > 0 && 'font-bold text-danger'
      )}
      title={
        approximate ? "Approximate: the queue service's counts can trail by a minute" : undefined
      }
    >
      <Wash value={`${approximate ? '≈' : ''}${figure(value)}`} />
    </span>
  );
}

function Age({ ms }: { ms: number | null }) {
  return ms === null ? (
    <span className="text-faint">unknown</span>
  ) : (
    <span className="tnum">
      <Wash value={span(ms)} steady />
    </span>
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
  // The rows that come with the first reading rise in a stagger; one a later poll adds does not.
  const first = useFirstLoad(true);
  return (
    <TableScroll>
      <Table className="min-w-[960px]">
        <caption className="sr-only">Notification health per queue</caption>
        <THead>
          <tr>
            <Th>Queue</Th>
            <Th right>Ready to run</Th>
            <Th right>Not notified</Th>
            <Th right>In queue service</Th>
            {showInFlight && <Th right>Picked up</Th>}
            {showDelayed && <Th right>Delayed</Th>}
            <Th right>Oldest waiting</Th>
            <Th right>Failed notifications</Th>
            <Th>Queue service figures</Th>
          </tr>
        </THead>
        <tbody>
          {queues.map((queue, index) => {
            const verdict = doorbellVerdict(queue, lateAfterMs);
            const { state, word } = VERDICT[verdict.kind];
            return (
              <Tr
                key={queue.queue}
                status={ROW_BAR[verdictTone(verdict)]}
                arrive={first ? index : undefined}
              >
                <Td className="max-w-[22rem]">
                  <span className="block truncate font-bold text-fg">{queue.queue}</span>
                  <span className="mt-1.5 block">
                    <StatusPill state={state}>{word}</StatusPill>
                  </span>
                  <p className="mt-1.5 text-[13px] text-muted">{verdict.text}</p>
                </Td>
                <Td className="text-right">
                  <span className="tnum">
                    <Wash value={claimableLabel(queue.store)} />
                  </span>
                </Td>
                <Td className="text-right">
                  <Reading value={queue.store.notRung} />
                </Td>
                <Td className="text-right">
                  <Reading value={queue.doorbellDepth} approximate={approximate} />
                </Td>
                {showInFlight && (
                  <Td className="text-right">
                    <Reading value={queue.inFlight} approximate={approximate} />
                  </Td>
                )}
                {showDelayed && (
                  <Td className="text-right">
                    <Reading value={queue.delayed} approximate={approximate} />
                  </Td>
                )}
                <Td className="text-right">
                  <Age ms={queue.oldestUndeliveredAgeMs} />
                </Td>
                <Td className="text-right">
                  <Reading value={queue.deadLetterDepth} danger approximate={approximate} />
                  {queue.deadLetterOldestAgeMs !== null && (
                    <span className="block text-[13px] text-muted">
                      oldest <Age ms={queue.deadLetterOldestAgeMs} />
                    </span>
                  )}
                </Td>
                <Td className="text-[13px] text-muted">{freshnessLabel(queue)}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
