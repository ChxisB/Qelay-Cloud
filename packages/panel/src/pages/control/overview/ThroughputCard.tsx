import { AreaChart } from '@/components/ui/AreaChart';
import { axisLabels, spanMs, type ThroughputPoint, windowTitle } from './throughputHistory';

const formatRate = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** The Overview's one gradient: the push line. Pull stays a quiet grey line. */
export function ThroughputCard({ points }: { points: ThroughputPoint[] }) {
  const span = spanMs(points);
  return (
    <section
      aria-label="Throughput"
      className="flex min-w-0 flex-[2_1_420px] flex-col gap-4 rounded-card border border-line bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
        <div className="flex flex-col gap-[3px]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Throughput</h2>
          <p className="text-xs text-muted">Jobs per second, {windowTitle(span)}</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-[3px] w-3.5 rounded-sm"
              style={{
                background:
                  'linear-gradient(90deg, var(--brand-1), var(--brand-2), var(--brand-3))',
              }}
              aria-hidden="true"
            />
            Push
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[3px] w-3.5 rounded-sm bg-muted" aria-hidden="true" />
            Pull
          </span>
        </div>
      </div>
      <AreaChart
        height={190}
        floor={0.4}
        formatValue={formatRate}
        ariaLabel="Push and pull jobs per second"
        xLabels={axisLabels(span)}
        series={[
          {
            label: 'Push',
            color: 'var(--brand-2)',
            points: points.map((p) => p.push),
            area: true,
            gradient: true,
          },
          { label: 'Pull', color: 'var(--text-muted)', points: points.map((p) => p.pull) },
        ]}
      />
    </section>
  );
}
