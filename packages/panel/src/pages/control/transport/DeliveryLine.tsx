import type { CSSProperties } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { doorbellVerdict, figure, span } from '@/lib/ops/health';
import type { TransportQueue } from '@/lib/ops/types';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { useMinWidth } from '@/lib/useMinWidth';
import { Edge, Node } from '../overview/JobFlow';

const AT = {
  ready: { gridColumn: 1, gridRow: 1 },
  told: { gridColumn: 2, gridRow: 1 },
  queued: { gridColumn: 3, gridRow: 1 },
  gaveUp: { gridColumn: 4, gridRow: 1 },
  picked: { gridColumn: 5, gridRow: 1 },
} satisfies Record<string, CSSProperties>;

/** The total of a column, or null when any row in it is unknown: a gap is never counted as 0. */
function sum(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * How a job gets to a worker, drawn from the rows of the table below it and nothing else: ready in the database,
 * told to the queue service, picked up. A total over rows where any figure is unknown is "unknown", the lines say
 * what is held back or given up on, and a table cut off at its limit says its totals are of the queues shown.
 */
export function DeliveryLine({
  queues,
  lateAfterMs,
  approximate,
  truncated,
}: {
  queues: readonly TransportQueue[];
  lateAfterMs: number;
  approximate: boolean;
  truncated: boolean;
}) {
  const wide = useMinWidth(1024);
  const at = (place: CSSProperties) => (wide ? place : undefined);
  const mark = approximate ? '≈' : '';

  const ready = sum(queues.map((q) => q.store.claimable));
  const capped = queues.some((q) => q.store.capped) ? '+' : '';
  const notRung = sum(queues.map((q) => q.store.notRung));
  const oldest = Math.max(-1, ...queues.map((q) => q.store.oldestNotRungAgeMs ?? -1));
  const behind = queues.some((q) => doorbellVerdict(q, lateAfterMs).kind === 'tick-behind');
  const queued = sum(queues.map((q) => q.doorbellDepth));
  const givenUp = sum(queues.map((q) => q.deadLetterDepth));
  const reports = queues.some((q) => q.inFlight !== null);
  const picked = reports ? sum(queues.map((q) => q.inFlight)) : null;
  const silent = (values: ReadonlyArray<number | null>) =>
    `${values.filter((v) => v === null).length} of ${values.length} queues did not answer`;

  const told =
    notRung === null
      ? 'Not told yet: unknown'
      : notRung === 0
        ? '0 not told yet'
        : `${figure(notRung)} not told yet${oldest >= 0 ? `, oldest ${span(oldest)}` : ''}${behind ? '. Maintenance is behind.' : ''}`;
  const gaveUp =
    givenUp === null ? 'Given up on: unknown' : `${mark}${figure(givenUp)} given up on`;
  const readyText = ready === null ? 'unknown' : `${figure(ready)}${capped}`;
  const queuedText = queued === null ? 'unknown' : `${mark}${figure(queued)}`;
  const pickedText = !reports
    ? 'not reported'
    : picked === null
      ? 'unknown'
      : `${mark}${figure(picked)}`;

  const pulses = { told: useChangeFlash(queued), gaveUp: useChangeFlash(picked) };
  const sentence = `Of the queues shown${truncated ? ' (the table is cut off)' : ''}: ${readyText} ready to run, ${told}, ${queuedText} in the queue service, ${gaveUp}, ${pickedText} picked up.`;

  const nodes = [
    <Node
      key="ready"
      label="Ready to run"
      glyph="waiting"
      value={readyText}
      hint={ready === null ? 'The database did not say' : 'From the database'}
      index={0}
      style={at(AT.ready)}
    />,
    <Node
      key="queued"
      label="In queue service"
      glyph="waiting"
      value={queuedText}
      hint={queued === null ? silent(queues.map((q) => q.doorbellDepth)) : 'From the queue service'}
      index={1}
      style={at(AT.queued)}
    />,
    <Node
      key="picked"
      label={approximate ? 'Picked up (≈)' : 'Picked up'}
      glyph="active"
      tone="active"
      value={pickedText}
      hint={
        !reports
          ? 'This queue service does not count them'
          : picked === null
            ? silent(queues.map((q) => q.inFlight))
            : 'From the queue service'
      }
      index={2}
      style={at(AT.picked)}
    />,
  ];
  const edges = [
    <Edge
      key="told"
      index={3}
      pulse={pulses.told}
      vertical={!wide}
      dashed={notRung === null || notRung > 0}
      rate={told}
      style={wide ? AT.told : { height: '3.5rem' }}
    />,
    <Edge
      key="gaveUp"
      index={4}
      pulse={pulses.gaveUp}
      vertical={!wide}
      dashed={givenUp === null}
      danger={givenUp !== null && givenUp > 0}
      rate={gaveUp}
      style={wide ? AT.gaveUp : { height: '3.5rem' }}
    />,
  ];

  return (
    <section aria-label="How a job gets to a worker">
      <Card>
        <CardHeader
          title="How a job gets to a worker"
          sub={`Totals of the queues in the table below, as last read.${truncated ? ' The table is cut off, so these are the queues shown, not every queue.' : ''} A line pulses once when a count on it changes. Unknown stays unknown.`}
        />
        <p className="sr-only">{sentence}</p>
        {wide ? (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns:
                'minmax(0,1.3fr) minmax(140px,1fr) minmax(0,1.3fr) minmax(140px,1fr) minmax(0,1.3fr)',
            }}
          >
            {nodes[0]}
            {edges[0]}
            {nodes[1]}
            {edges[1]}
            {nodes[2]}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {nodes[0]}
            {edges[0]}
            {nodes[1]}
            {edges[1]}
            {nodes[2]}
          </div>
        )}
      </Card>
    </section>
  );
}
