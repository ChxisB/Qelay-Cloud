import { Link } from 'react-router-dom';
import { type StateRole, StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, type RowStatus, Tr } from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { useFirstLoad } from '@/lib/useFirstLoad';
import type { QueueHealth } from './model';

const LEGEND = [
  ['Ready', 'bg-faint'],
  ['Active', 'bg-state-active-fg'],
  ['Delayed', 'bg-state-delayed-fg'],
  ['DLQ', 'bg-danger-fill'],
] as const;

interface Split {
  ready: number;
  active: number;
  delayed: number;
  dlq: number;
}

function splitOf(q: QueueHealth): Split {
  return {
    ready: (q.counts?.waiting ?? 0) + (q.counts?.prioritized ?? 0),
    active: q.counts?.active ?? 0,
    delayed: q.counts?.delayed ?? 0,
    dlq: q.dlq ?? 0,
  };
}

interface RowState {
  role: StateRole;
  word: string;
  bar?: RowStatus;
}

/** One word and glyph per row, so the bar is never the only signal. A missing reading is "Unknown", not healthy. */
function rowState(q: QueueHealth, s: Split): RowState {
  if (s.dlq > 0 || (q.counts?.failed ?? 0) > 0)
    return { role: 'failed', word: 'Failing', bar: 'bad' };
  if (q.paused) return { role: 'waiting', word: 'Paused', bar: 'idle' };
  if (!q.counts) return { role: 'waiting', word: 'Unknown' };
  if (s.active > 0) return { role: 'active', word: 'Active', bar: 'active' };
  return { role: 'completed', word: 'Healthy' };
}

function DistributionBar({ split }: { split: Split }) {
  const parts = [
    [split.ready, 'bg-faint', 'ready'],
    [split.active, 'bg-state-active-fg', 'active'],
    [split.delayed, 'bg-state-delayed-fg', 'delayed'],
    [split.dlq, 'bg-danger-fill', 'in the DLQ'],
  ] as const;
  const shown = parts.filter(([n]) => n > 0);
  return (
    <div
      role="img"
      aria-label={shown.length ? shown.map(([n, , l]) => `${n} ${l}`).join(', ') : 'empty'}
      className="flex h-2 gap-0.5 overflow-hidden rounded bg-line"
    >
      {shown.map(([n, color, label]) => (
        <div key={label} className={cn(color, 'motion-fill')} style={{ flex: `${n} 1 0` }} />
      ))}
    </div>
  );
}

function Num({ value, tone }: { value: number | null; tone?: 'danger' }) {
  const flash = useChangeFlash(value);
  if (value == null) return <span className="text-faint">—</span>;
  return (
    <span
      key={flash}
      className={cn(
        'tnum',
        value === 0 && 'text-muted',
        tone === 'danger' && value > 0 && 'font-semibold text-danger',
        flash > 0 && 'motion-flash'
      )}
    >
      {formatNumber(value)}
    </span>
  );
}

export function QueueHealthTable({ rows, total }: { rows: QueueHealth[]; total: number }) {
  const first = useFirstLoad(rows.length > 0);
  return (
    <section
      aria-label="Queue health"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 pb-3.5 pt-[18px]">
        <div className="flex flex-col gap-[3px]">
          <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Queue health</h2>
          <p className="text-xs text-muted">
            {total} {total === 1 ? 'queue' : 'queues'} · sorted by what needs attention
          </p>
        </div>
        <ul className="flex items-center gap-3.5 text-xs text-muted">
          {LEGEND.map(([label, color]) => (
            <li key={label} className="inline-flex items-center gap-1.5">
              <span className={cn('size-2 rounded-xs', color)} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-line py-6 text-center text-sm text-faint">No queues yet.</p>
      ) : (
        <TableScroll>
          <Table>
            <THead>
              <tr>
                <Th>Queue</Th>
                <Th className="hidden sm:table-cell">Distribution</Th>
                {['Ready', 'Active', 'Delayed', 'DLQ'].map((h) => (
                  <Th key={h} tight right className="sm:w-20">
                    {h}
                  </Th>
                ))}
              </tr>
            </THead>
            <tbody>
              {rows.map((q, index) => {
                const s = splitOf(q);
                const state = rowState(q, s);
                return (
                  <Tr key={q.name} status={state.bar} arrive={first ? index : undefined}>
                    <Td className="max-w-[8rem] sm:max-w-none">
                      <span className="flex flex-col items-start gap-1.5">
                        <Link
                          to={`/queues/${encodeURIComponent(q.name)}`}
                          className="max-w-full truncate font-bold text-fg hover:text-link"
                        >
                          {q.name}
                        </Link>
                        <StatusPill state={state.role}>{state.word}</StatusPill>
                      </span>
                    </Td>
                    <Td className="hidden sm:table-cell">
                      <DistributionBar split={s} />
                    </Td>
                    <Td tight className="text-right">
                      <Num value={q.counts ? s.ready : null} />
                    </Td>
                    <Td tight className="text-right">
                      <Num value={q.counts ? s.active : null} />
                    </Td>
                    <Td tight className="text-right">
                      <Num value={q.counts ? s.delayed : null} />
                    </Td>
                    <Td tight className="text-right">
                      <Num value={q.dlq} tone="danger" />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
      {total > rows.length && (
        <div className="border-t border-line px-4 py-3 text-[13px]">
          <Link to="/queues" className="text-link hover:underline">
            View all {total} queues
          </Link>
        </div>
      )}
    </section>
  );
}
