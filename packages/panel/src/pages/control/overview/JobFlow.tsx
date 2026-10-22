import type { CSSProperties, ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { type StatTone, toneClass } from '@/components/ui/StatCard';
import { type StateRole, StatusGlyph } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { formatCompact, formatNumber } from '@/lib/format';
import { stagger } from '@/lib/stagger';
import { useChangeFlash, useRises } from '@/lib/useChangeFlash';
import { useMinWidth } from '@/lib/useMinWidth';
import { type OverviewSnapshot, WAITING_AMBER_THRESHOLD } from './model';

/** Where a node sits in the wide grid; the nodes take the odd rows and the even columns, the lines the rest. */
const AT = {
  push: { gridColumn: 1, gridRow: 3 },
  ready: { gridColumn: 2, gridRow: 3 },
  pull: { gridColumn: 3, gridRow: 3 },
  active: { gridColumn: 4, gridRow: 3 },
  done: { gridColumn: 5, gridRow: 3 },
  completed: { gridColumn: 6, gridRow: 3 },
  delayed: { gridColumn: 2, gridRow: 1 },
  delayedLine: { gridColumn: 2, gridRow: 2 },
  failed: { gridColumn: 4, gridRow: 5 },
  failedLine: { gridColumn: 4, gridRow: 4 },
} satisfies Record<string, CSSProperties>;

export function Node({
  label,
  glyph,
  value,
  tone = 'default',
  hint,
  index,
  style,
  danger,
}: {
  label: string;
  glyph?: StateRole;
  value: string;
  tone?: StatTone;
  hint: ReactNode;
  index: number;
  style?: CSSProperties;
  danger?: boolean;
}) {
  const flash = useChangeFlash(value);
  return (
    <div
      style={{ ...stagger(index), ...style }}
      className={cn(
        'motion-arrive flex min-w-0 flex-col gap-1 rounded-card border bg-bg px-4 py-3',
        danger ? 'border-danger/40' : 'border-line-strong'
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {glyph && <StatusGlyph state={glyph} small />}
        {label}
      </div>
      <div
        key={flash}
        className={cn(
          'tnum text-[22px] font-semibold leading-[1.1] tracking-[-0.02em]',
          toneClass[tone],
          flash > 0 && 'motion-flash'
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted">{hint}</div>
    </div>
  );
}

/** A line with the rate (or nothing) on it. The sentence above the diagram says what each one means. */
export function Edge({
  index,
  pulse,
  vertical,
  danger,
  dashed,
  rate,
  style,
}: {
  index: number;
  pulse: number;
  vertical?: boolean;
  danger?: boolean;
  dashed?: boolean;
  rate?: string;
  style?: CSSProperties;
}) {
  return (
    <div style={style} className={cn(!style && 'h-8')}>
      <ConnectionLine
        state={dashed ? 'held' : 'active'}
        tone={danger ? 'text-bad' : 'text-line-strong'}
        vertical={vertical}
        index={index}
        pulse={pulse}
      >
        {rate && (
          <span className="tnum rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-muted">
            {rate}
          </span>
        )}
      </ConnectionLine>
    </div>
  );
}

/**
 * The job lifecycle as read at the last poll: pushed in, waiting, active, completed, with delayed feeding the
 * backlog and failed branching off active. A line pulses once only when the figure it feeds really changed.
 * Failed joins only while recorded failures exist, so a healthy server shows the five-node designed flow.
 */
export function JobFlow({ snapshot: s }: { snapshot: OverviewSnapshot }) {
  const wide = useMinWidth(1024);
  const { stats, throughput } = s.overview;
  const failing = s.failedTotal > 0;
  const push = throughput.pushPerSec.toFixed(2);
  const pull = throughput.pullPerSec.toFixed(2);
  const pulses = {
    push: useRises(stats.totalPushed),
    pull: useChangeFlash(stats.active),
    done: useRises(stats.completed),
    delayed: useChangeFlash(s.delayedTotal),
    failed: useRises(s.failedTotal),
  };
  const sentence = [
    `Push ${push} jobs per second into the ready backlog of ${formatNumber(s.readyTotal)}.`,
    `Workers pull ${pull} jobs per second: ${formatNumber(stats.active)} active now, ${formatNumber(stats.completed)} completed.`,
    `${formatNumber(s.delayedTotal)} delayed for later.`,
    failing && `${formatNumber(s.failedTotal)} failed, recorded across queues.`,
  ]
    .filter(Boolean)
    .join(' ');

  const ready = (
    <Node
      label="Ready backlog"
      glyph="waiting"
      value={formatNumber(s.readyTotal)}
      tone={s.readyTotal > WAITING_AMBER_THRESHOLD ? 'amber' : 'default'}
      hint={`${formatNumber(s.waitingTotal)} waiting · ${formatNumber(s.prioritizedTotal)} prioritized`}
      index={0}
      style={wide ? AT.ready : undefined}
    />
  );
  const active = (
    <Node
      label="Active"
      glyph="active"
      value={formatNumber(stats.active)}
      tone="active"
      hint="in flight now"
      index={1}
      style={wide ? AT.active : undefined}
    />
  );
  const completed = (
    <Node
      label="Completed"
      glyph="completed"
      value={formatNumber(stats.completed)}
      tone="green"
      hint={`${formatCompact(stats.totalPushed)} pushed since restart`}
      index={2}
      style={wide ? AT.completed : undefined}
    />
  );
  const delayed = (
    <Node
      label="Delayed"
      value={formatNumber(s.delayedTotal)}
      hint="scheduled for later"
      index={3}
      style={wide ? AT.delayed : undefined}
    />
  );
  const failed = failing && (
    <Node
      label="Failed"
      glyph="failed"
      value={formatNumber(s.failedTotal)}
      tone="red"
      hint="recorded across queues"
      index={4}
      danger
      style={wide ? AT.failed : undefined}
    />
  );

  return (
    <Card>
      <CardHeader
        title="Job flow"
        sub="Where jobs are, as last read. The lines show direction only."
        action={
          <span className="text-xs text-muted">Completed counts since the server restarted</span>
        }
      />
      <p className="sr-only">{sentence}</p>
      {wide ? (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns:
              'minmax(72px,0.8fr) minmax(0,1.6fr) minmax(72px,0.9fr) minmax(0,1.6fr) minmax(72px,0.9fr) minmax(0,1.6fr)',
            gridTemplateRows: failing ? 'auto 2rem auto 2rem auto' : 'auto 2rem auto',
          }}
        >
          {delayed}
          <Edge vertical dashed index={5} pulse={pulses.delayed} style={AT.delayedLine} />
          <Edge index={6} pulse={pulses.push} rate={`${push} / s`} style={AT.push} />
          {ready}
          <Edge index={7} pulse={pulses.pull} rate={`${pull} / s`} style={AT.pull} />
          {active}
          <Edge index={8} pulse={pulses.done} style={AT.done} />
          {completed}
          {failing && (
            <Edge vertical danger index={9} pulse={pulses.failed} style={AT.failedLine} />
          )}
          {failed}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Edge vertical index={5} pulse={pulses.push} rate={`${push} / s`} />
          {ready}
          <Edge vertical index={6} pulse={pulses.pull} rate={`${pull} / s`} />
          {active}
          <Edge vertical index={7} pulse={pulses.done} />
          {completed}
          <div className="grid grid-cols-2 gap-4">
            {delayed}
            {failed}
          </div>
        </div>
      )}
    </Card>
  );
}
