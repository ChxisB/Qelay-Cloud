import { Legend } from './Legend';
import { fmt, STROKE, type Tone } from './tones';

const R = 42;
const C = 2 * Math.PI * R;

/** Ring of segments with the total in the middle and a labelled key beside it. */
export function Donut({
  segments,
  label,
  centre,
  caption,
}: {
  segments: Array<{ label: string; value: number; tone: Tone }>;
  label: string;
  /** The big figure in the middle; defaults to the sum. */
  centre?: string;
  caption?: string;
}) {
  const sum = segments.reduce((n, s) => n + s.value, 0);
  const pct = (v: number) => (sum > 0 ? Math.round((v / sum) * 100) : 0);
  const listed = segments.map((s) => `${s.label} ${fmt(s.value)} (${pct(s.value)}%)`).join(', ');
  // Each arc starts where the previous one ended; the running start is a prefix sum, not a mutation.
  const arcs = segments.map((s, i) => ({
    s,
    len: sum > 0 ? (s.value / sum) * C : 0,
    at: segments.slice(0, i).reduce((n, p) => n + (sum > 0 ? (p.value / sum) * C : 0), 0),
  }));
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative size-[168px] flex-none">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${label}: ${listed}`}
          className="size-full -rotate-90"
        >
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            strokeWidth="9.5"
            className="stroke-slate-tint"
          />
          {arcs.map(({ s, len, at }) => (
            <circle
              key={s.label}
              cx="50"
              cy="50"
              r={R}
              fill="none"
              strokeWidth="9.5"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-at}
              className={STROKE[s.tone]}
            />
          ))}
        </svg>
        <div className="absolute inset-0 grid place-content-center text-center">
          <b className="text-[20px] leading-none font-bold tracking-tight text-fg">
            {centre ?? fmt(sum)}
          </b>
          {caption && <span className="text-xs font-semibold text-muted">{caption}</span>}
        </div>
      </div>
      <Legend
        items={segments.map((s) => ({
          tone: s.tone,
          label: s.label,
          value: `${fmt(s.value)} · ${pct(s.value)}%`,
        }))}
      />
    </div>
  );
}
