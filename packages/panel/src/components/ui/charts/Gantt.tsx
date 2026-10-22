import { FILL, type Tone } from './tones';

export interface GanttRow {
  label: string;
  /** Offsets from the start, in the same unit as `total`. */
  start: number;
  end: number;
  tone?: Tone;
  /** Text at the end of the row, for example "1.2 s". */
  duration: string;
}

const COLS = 'grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_70px] items-center gap-4';

/** Steps as bars on a shared time axis, for a flow's run. The name gives each step's duration. */
export function Gantt({
  rows,
  total,
  label,
  axis,
}: {
  rows: GanttRow[];
  total: number;
  label: string;
  /** Tick labels along the bottom, first to last. */
  axis?: string[];
}) {
  const span = total > 0 ? total : 1;
  const listed = rows.map((r) => `${r.label} ${r.duration}`).join(', ');
  return (
    <div role="img" aria-label={`${label}: ${listed}`} className="flex flex-col">
      {rows.map((r) => {
        const left = Math.min(100, Math.max(0, (r.start / span) * 100));
        const width = Math.min(100 - left, Math.max(1, ((r.end - r.start) / span) * 100));
        return (
          <div
            key={r.label}
            className={`${COLS} min-h-[42px] border-t border-line first:border-t-0`}
          >
            <span className="min-w-0 truncate text-[13px] font-bold text-fg">{r.label}</span>
            <div className="relative h-3.5 rounded-full bg-slate-tint">
              <span
                className={`absolute top-0 h-3.5 rounded-full ${FILL[r.tone ?? 'ok']}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className="text-right font-mono text-xs font-medium text-muted">
              {r.duration}
            </span>
          </div>
        );
      })}
      {axis && (
        <div className={`${COLS} text-xs text-faint`}>
          <span />
          <div className="flex justify-between">
            {axis.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
          <span />
        </div>
      )}
    </div>
  );
}
