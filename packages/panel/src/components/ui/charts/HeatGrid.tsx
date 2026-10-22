import { cn } from '@/lib/cn';
import type { Tone } from './tones';

/** A cell is a status (`ok`, `warn`, `active`, `bad`), a load from 1 to 4, or 0 for empty. */
export type HeatCell = Extract<Tone, 'ok' | 'warn' | 'active' | 'bad'> | 0 | 1 | 2 | 3 | 4;

const STATUS: Record<string, string> = {
  ok: 'bg-ok/70',
  warn: 'bg-warn',
  active: 'bg-active',
  // Stripes at a finer pitch than the bars, so the cell reads as striped at 8px.
  bad: 'bg-[repeating-linear-gradient(135deg,var(--bad)_0_3px,color-mix(in_srgb,var(--bad)_50%,var(--surface))_3px_6px)]',
};
const LOAD = ['bg-slate-tint', 'bg-active/20', 'bg-active/45', 'bg-active/70', 'bg-active'];

export interface HeatRow {
  label: string;
  cells: HeatCell[];
  /** What the row amounts to, for the name; defaults to the count of marked cells. */
  summary?: string;
}

/** One strip of equal cells per row, for a day or a week. The name gives each row's count. */
export function HeatGrid({ rows, label }: { rows: HeatRow[]; label: string }) {
  const listed = rows
    .map(
      (r) => `${r.label} ${r.summary ?? `${r.cells.filter(Boolean).length} of ${r.cells.length}`}`
    )
    .join(', ');
  return (
    <div role="img" aria-label={`${label}: ${listed}`} className="flex flex-col gap-2">
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid min-h-[34px] items-center gap-4 min-[600px]:grid-cols-[170px_minmax(0,1fr)]"
        >
          <span className="min-w-0 truncate text-[13px] font-bold text-fg">{r.label}</span>
          <div
            className="grid gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${r.cells.length}, minmax(0, 1fr))` }}
          >
            {r.cells.map((cell, i) => (
              // A strip is a fixed-length series that never reorders: position is the key.
              <span
                // oxlint-disable-next-line react/no-array-index-key -- positional cells
                key={i}
                className={cn(
                  'aspect-square rounded-[4px]',
                  typeof cell === 'number' ? LOAD[cell] : STATUS[cell]
                )}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
