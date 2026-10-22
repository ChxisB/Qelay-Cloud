import type { CSSProperties } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { formatNumber } from '@/lib/format';
import { useChangeFlash, useRises } from '@/lib/useChangeFlash';
import { useMinWidth } from '@/lib/useMinWidth';
import { Edge, Node } from '../overview/JobFlow';

type Counts = Pick<
  QueueSummaryFull['counts'],
  'waiting' | 'prioritized' | 'active' | 'completed' | 'failed' | 'delayed'
>;

/** Where a node sits in the wide grid: nodes on the odd rows and columns, the lines between them. */
const AT = {
  delayed: { gridColumn: 1, gridRow: 1 },
  delayedLine: { gridColumn: 1, gridRow: 2 },
  ready: { gridColumn: 1, gridRow: 3 },
  pull: { gridColumn: 2, gridRow: 3 },
  active: { gridColumn: 3, gridRow: 3 },
  done: { gridColumn: 4, gridRow: 3 },
  completed: { gridColumn: 5, gridRow: 3 },
  failedLine: { gridColumn: 3, gridRow: 4 },
  failed: { gridColumn: 3, gridRow: 5 },
} satisfies Record<string, CSSProperties>;

/**
 * Where this queue's jobs are, from the counts the page already reads: ready, active, completed, with delayed
 * feeding the backlog and failed branching off active (only while some are recorded). A line pulses once only
 * when the figure it feeds really changed.
 */
export function QueueLifecycle({ counts: c }: { counts: Counts }) {
  const wide = useMinWidth(768);
  const failing = c.failed > 0;
  const ready = c.waiting + c.prioritized;
  const pulses = {
    pull: useChangeFlash(c.active),
    done: useRises(c.completed),
    delayed: useChangeFlash(c.delayed),
    failed: useRises(c.failed),
  };
  const sentence = [
    `${formatNumber(ready)} ready (${formatNumber(c.waiting)} waiting, ${formatNumber(c.prioritized)} prioritized).`,
    `${formatNumber(c.active)} active now, ${formatNumber(c.completed)} completed.`,
    `${formatNumber(c.delayed)} delayed for later.`,
    failing && `${formatNumber(c.failed)} failed.`,
  ]
    .filter(Boolean)
    .join(' ');
  const at = (place: CSSProperties) => (wide ? place : undefined);

  const nodes = {
    ready: (
      <Node
        label="Ready"
        glyph="waiting"
        value={formatNumber(ready)}
        hint={`${formatNumber(c.waiting)} waiting · ${formatNumber(c.prioritized)} prioritized`}
        index={0}
        style={at(AT.ready)}
      />
    ),
    active: (
      <Node
        label="Active"
        glyph="active"
        value={formatNumber(c.active)}
        tone="active"
        hint="in flight now"
        index={1}
        style={at(AT.active)}
      />
    ),
    completed: (
      <Node
        label="Completed"
        glyph="completed"
        value={formatNumber(c.completed)}
        tone="green"
        hint="finished"
        index={2}
        style={at(AT.completed)}
      />
    ),
    delayed: (
      <Node
        label="Delayed"
        value={formatNumber(c.delayed)}
        hint="scheduled for later"
        index={3}
        style={at(AT.delayed)}
      />
    ),
    failed: failing && (
      <Node
        label="Failed"
        glyph="failed"
        value={formatNumber(c.failed)}
        tone="red"
        hint="recorded on this queue"
        index={4}
        danger
        style={at(AT.failed)}
      />
    ),
  };

  return (
    <Card className="mb-6">
      <CardHeader
        title="Where this queue's jobs are"
        sub="As last read. A line pulses once when a count on it changes."
      />
      <p className="sr-only">{sentence}</p>
      {wide ? (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns:
              'minmax(0,1.6fr) minmax(72px,0.9fr) minmax(0,1.6fr) minmax(72px,0.9fr) minmax(0,1.6fr)',
            gridTemplateRows: failing ? 'auto 2rem auto 2rem auto' : 'auto 2rem auto',
          }}
        >
          {nodes.delayed}
          <Edge vertical dashed index={5} pulse={pulses.delayed} style={AT.delayedLine} />
          {nodes.ready}
          <Edge index={6} pulse={pulses.pull} style={AT.pull} />
          {nodes.active}
          <Edge index={7} pulse={pulses.done} style={AT.done} />
          {nodes.completed}
          {failing && (
            <Edge vertical danger index={8} pulse={pulses.failed} style={AT.failedLine} />
          )}
          {nodes.failed}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {nodes.ready}
          <Edge vertical index={5} pulse={pulses.pull} />
          {nodes.active}
          <Edge vertical index={6} pulse={pulses.done} />
          {nodes.completed}
          <div className="grid grid-cols-2 gap-4">
            {nodes.delayed}
            {nodes.failed}
          </div>
        </div>
      )}
    </Card>
  );
}
