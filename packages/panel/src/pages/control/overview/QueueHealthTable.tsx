import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
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

function rowDot(q: QueueHealth, s: Split): string {
  if (s.dlq > 0 || (q.counts?.failed ?? 0) > 0) return 'bg-danger-fill';
  if (q.paused) return 'bg-state-waiting-fg';
  return s.active > 0 ? 'bg-state-active-fg' : 'bg-success';
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
        <div key={label} className={color} style={{ flex: `${n} 1 0` }} />
      ))}
    </div>
  );
}

function Num({ value, tone }: { value: number | null; tone?: 'danger' }) {
  if (value == null) return <span className="text-faint">—</span>;
  return (
    <span
      className={cn(
        'tnum',
        value === 0 && 'text-muted',
        tone === 'danger' && value > 0 && 'font-semibold text-danger'
      )}
    >
      {formatNumber(value)}
    </span>
  );
}

export function QueueHealthTable({ rows, total }: { rows: QueueHealth[]; total: number }) {
  return (
    <section
      aria-label="Queue health"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 pb-3.5 pt-[18px]">
        <div className="flex flex-col gap-[3px]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Queue health</h2>
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
        <p className="border-t border-line py-8 text-center text-sm text-faint">No queues yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line text-left eyebrow text-muted">
                <th className="px-3 py-2.5 font-semibold sm:px-4">Queue</th>
                <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">Distribution</th>
                {['Ready', 'Active', 'Delayed', 'DLQ'].map((h) => (
                  <th
                    key={h}
                    className="px-1.5 py-2.5 text-right font-semibold tracking-[0.1em] sm:w-20 sm:px-4 sm:tracking-[0.18em]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const s = splitOf(q);
                return (
                  <tr key={q.name} className="border-b border-line last:border-b-0 hover:bg-hover">
                    <td className="max-w-[6.5rem] px-3 py-3.5 sm:max-w-none sm:px-4">
                      <span className="flex items-center gap-2.5">
                        <span
                          className={cn('size-2 shrink-0 rounded-full', rowDot(q, s))}
                          aria-hidden="true"
                        />
                        <Link
                          to={`/queues/${encodeURIComponent(q.name)}`}
                          className="truncate font-semibold text-fg hover:text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {q.name}
                        </Link>
                        {q.paused && (
                          <span className="rounded-full bg-state-waiting-bg px-2 py-0.5 text-[11px] font-medium text-state-waiting-fg">
                            paused
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3.5 sm:table-cell">
                      <DistributionBar split={s} />
                    </td>
                    <td className="px-1.5 py-3.5 text-right sm:px-4">
                      <Num value={q.counts ? s.ready : null} />
                    </td>
                    <td className="px-1.5 py-3.5 text-right sm:px-4">
                      <Num value={q.counts ? s.active : null} />
                    </td>
                    <td className="px-1.5 py-3.5 text-right sm:px-4">
                      <Num value={q.counts ? s.delayed : null} />
                    </td>
                    <td className="px-1.5 py-3.5 text-right sm:px-4">
                      <Num value={q.dlq} tone="danger" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
