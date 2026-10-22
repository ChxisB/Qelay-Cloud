import { fmt, SOLID, type Tone } from './tones';

/** A rounded track with a fill. Standalone it is a `meter`; inside `HBars` it is decoration. */
export function Meter({
  value,
  max = 100,
  tone = 'ok',
  small = false,
  label,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  small?: boolean;
  /** Required for the standalone meter: what it measures. */
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      {...(label
        ? {
            role: 'meter',
            'aria-label': label,
            'aria-valuenow': value,
            'aria-valuemin': 0,
            'aria-valuemax': max,
          }
        : {})}
      className={`overflow-hidden rounded-full bg-slate-tint ${small ? 'h-1.5' : 'h-2.5'}`}
    >
      {/* Scaled, not resized: only a transform moves, and the first draw and every change ease in (motion-fill). */}
      <span
        className={`motion-fill block h-full w-full rounded-full ${SOLID[tone]}`}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}

export interface HBarRow {
  label: string;
  value: number;
  /** Text shown at the end of the row; defaults to the number. */
  display?: string;
  tone?: Tone;
}

/** Horizontal bars, one per row, scaled to the largest value. The name lists every row. */
export function HBars({ rows, label }: { rows: HBarRow[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const listed = rows.map((r) => `${r.label} ${r.display ?? fmt(r.value)}`).join(', ');
  return (
    <div role="img" aria-label={`${label}: ${listed}`} className="flex flex-col gap-3.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5"
        >
          <span className="min-w-0 truncate text-[13px] font-bold text-fg">{r.label}</span>
          <span className="text-[13px] text-muted">{r.display ?? fmt(r.value)}</span>
          <div className="col-span-full">
            <Meter value={r.value} max={max} tone={r.tone} />
          </div>
        </div>
      ))}
    </div>
  );
}
