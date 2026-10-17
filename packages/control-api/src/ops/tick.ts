import type { TickSnapshot } from '../deps';
import type { TickState } from '../opsTypes';

export interface TickReading {
  readonly state: TickState;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly ageMs: number | null;
}

/**
 * How long ago the tick last ran to the end, on the database's clock, against the two thresholds.
 * `unknown` is a tick row that could not be read; `never` is a readable row with no success in it,
 * which is a tick that has not started (or one that fails every time).
 */
export function readTick(
  snapshot: TickSnapshot | null,
  lateAfterMs: number,
  staleAfterMs: number
): TickReading {
  if (snapshot === null) {
    return { state: 'unknown', lastSuccessAt: null, lastFailureAt: null, ageMs: null };
  }
  const { lastSuccessAt, lastFailureAt } = snapshot;
  if (lastSuccessAt === null) return { state: 'never', lastSuccessAt, lastFailureAt, ageMs: null };
  const ageMs = Math.max(0, snapshot.now - lastSuccessAt);
  const state: TickState = ageMs >= staleAfterMs ? 'stale' : ageMs >= lateAfterMs ? 'late' : 'ok';
  return { state, lastSuccessAt, lastFailureAt, ageMs };
}

/** "5 minutes", "90 seconds": a threshold as a person would say it. */
export function spoken(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.round(ms / 1_000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}
