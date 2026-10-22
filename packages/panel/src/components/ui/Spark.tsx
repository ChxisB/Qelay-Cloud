/** Line and area paths for a series on a 100x40 grid, ported from the boards' `Q.spark`. */
export function sparkPaths(values: readonly number[]): { line: string; area: string } {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const line = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 36 - ((v - lo) / span) * 30;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return { line, area: `${line} L100 40 L0 40 Z` };
}

/** Decorative trend line in the current text colour. Draws nothing for fewer than two points. */
export function Spark({ values, className }: { values: readonly number[]; className?: string }) {
  if (values.length < 2) return null;
  const { line, area } = sparkPaths(values);
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={`mt-1.5 block h-11 w-full ${className ?? ''}`}
    >
      <path d={area} fill="currentColor" fillOpacity={0.12} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
