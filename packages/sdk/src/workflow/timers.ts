/** The longest delay one native timer accepts: 2^31 - 1 ms, about 24.8 days. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * One native delay for an abstraction that takes a single timer: finite values clamp to
 * [0, 2^31 - 1], Infinity to 2^31 - 1 and -Infinity to 0. The caller re-checks its deadline when
 * the timer fires, because a clamped delay fires before a longer one would. NaN throws.
 * Ported from `../qelay/src/shared/timers.ts` (`clampTimerDelay` only).
 */
export function clampTimerDelay(ms: number): number {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    throw new TypeError(`Timer delay must be a number of milliseconds (got ${String(ms)})`);
  }
  return ms > 0 ? Math.min(ms, MAX_TIMER_DELAY_MS) : 0;
}
