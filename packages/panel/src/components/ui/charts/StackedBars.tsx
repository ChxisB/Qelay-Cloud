import { FILL, fmt, type Tone } from './tones';

export interface BarColumn {
  label: string;
  values: Partial<Record<Tone, number>>;
}

/**
 * Stacked columns on a dashed grid; the first series sits at the bottom. The name holds each
 * series' total, because the picture alone does not give the numbers.
 */
export function StackedBars({
  columns,
  series,
  label,
  height = 240,
}: {
  columns: BarColumn[];
  series: Array<{ tone: Tone; name: string }>;
  label: string;
  height?: number;
}) {
  const total = (c: BarColumn) => series.reduce((n, s) => n + (c.values[s.tone] ?? 0), 0);
  const max = Math.max(1, ...columns.map(total));
  const sums = series
    .map((s) => `${s.name} ${fmt(columns.reduce((n, c) => n + (c.values[s.tone] ?? 0), 0))}`)
    .join(', ');
  const gap = 'gap-[clamp(2px,0.4vw,6px)]';
  return (
    <div role="img" aria-label={`${label}: ${sums}`} className="flex gap-3">
      <div
        className="flex min-w-7 flex-col justify-between text-right text-xs text-faint"
        style={{ height }}
      >
        <span>{fmt(max)}</span>
        <span>{fmt(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative border-b border-line-strong" style={{ height }}>
          {[0.25, 0.5, 0.75].map((f) => (
            <div
              key={f}
              className="absolute inset-x-0 border-t border-dashed border-line"
              style={{ top: `${f * 100}%` }}
            />
          ))}
          <div className={`absolute inset-0 flex items-end ${gap}`}>
            {columns.map((c) => (
              <div key={c.label} className="flex h-full min-w-0 flex-1 items-end">
                <div
                  className="flex min-h-[2px] w-full flex-col-reverse overflow-hidden rounded-t-[6px]"
                  style={{ height: `${(total(c) / max) * 100}%` }}
                >
                  {series.map((s) =>
                    c.values[s.tone] ? (
                      <div
                        key={s.tone}
                        className={FILL[s.tone]}
                        style={{ flexGrow: c.values[s.tone] }}
                      />
                    ) : null
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className={`mt-2 flex ${gap}`}>
          {columns.map((c) => (
            <span
              key={c.label}
              className="min-w-0 flex-1 text-center text-xs whitespace-nowrap text-faint"
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
