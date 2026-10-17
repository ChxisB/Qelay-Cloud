/**
 * Rolling push/pull history for the Overview throughput chart. It is built from the
 * page's own poll (one point per successful poll), so the chart adds no requests.
 */
export interface ThroughputPoint {
  at: number;
  push: number;
  pull: number;
}

export const THROUGHPUT_WINDOW_MS = 5 * 60_000;

/** A poll gap longer than this restarts the window instead of drawing a line across it. */
export function gapLimitMs(refreshMs: number): number {
  return Math.max(10_000, refreshMs * 4);
}

export function appendSample(
  points: readonly ThroughputPoint[],
  sample: ThroughputPoint,
  gapMs: number
): ThroughputPoint[] {
  const last = points[points.length - 1];
  const kept = last && sample.at - last.at > gapMs ? [] : points;
  return [...kept, sample].filter((p) => sample.at - p.at <= THROUGHPUT_WINDOW_MS);
}

export function spanMs(points: readonly ThroughputPoint[]): number {
  return points.length < 2 ? 0 : points[points.length - 1].at - points[0].at;
}

/** "last minute" / "last N minutes", rounded up and capped at the window. */
export function windowTitle(span: number): string {
  const minutes = Math.min(5, Math.max(1, Math.ceil(span / 60_000)));
  return minutes === 1 ? 'last minute' : `last ${minutes} minutes`;
}

/** One unit for the whole axis, chosen from the span, so labels never mix "−60s" with "−2m". */
function ago(ms: number, span: number): string {
  return span < 120_000 ? `−${Math.round(ms / 1000)}s` : `−${Math.round(ms / 60_000)}m`;
}

/**
 * Six evenly spaced x labels, oldest to "now". Empty until the chart has a second of history.
 * On a short span the rounded labels would collide (and repeat as React keys), so the axis
 * falls back to just its two ends.
 */
export function axisLabels(span: number): string[] {
  if (span < 1000) return [];
  const labels = Array.from({ length: 6 }, (_, i) =>
    i === 5 ? 'now' : ago((span * (5 - i)) / 5, span)
  );
  return new Set(labels).size === labels.length ? labels : [labels[0], 'now'];
}
