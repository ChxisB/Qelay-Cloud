import type { BackoffOptions } from '@qelay-cloud/core';

/** Upstream's `DEFAULT_MAX_BACKOFF`: one hour. A job's `backoff.maxDelay` replaces it. */
export const DEFAULT_MAX_BACKOFF_MS = 3_600_000;
/** Upstream's default retry base (`JOB_DEFAULTS.backoff`), used when a stored base is unusable. */
export const DEFAULT_BACKOFF_BASE_MS = 1000;
/** 2^1023 is the largest finite power of two: a higher exponent would turn `0 * 2^n` into NaN. */
const MAX_EXPONENT = 1023;

/** A number in [0, 1). The model harness injects a seeded one, so a run replays. */
export type Random = () => number;

export interface BackoffPolicy {
  /** Off by default: the delay is then exactly the documented formula and nothing random enters it. */
  readonly jitter: boolean;
  readonly random: Random;
}

export const NO_JITTER: BackoffPolicy = { jitter: false, random: Math.random };

type StoredBackoff = Pick<BackoffOptions, 'type' | 'delay' | 'maxDelay'>;

const usableBase = (value: unknown): number =>
  typeof value === 'number' && value >= 0 ? value : DEFAULT_BACKOFF_BASE_MS;

const usableCap = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_MAX_BACKOFF_MS;

/**
 * How long a job waits before its next try, in whole milliseconds, never less than 0 and never
 * more than the cap. Adapted from Qelay's `calculateBackoff` (see docs/PORTING.md).
 *
 * `attempts` is the number of tries counted so far **including the one that just failed**, so the
 * first retry sees 1. With `base` = `backoff.delay` and `cap` = `backoff.maxDelay` (default 1 hour):
 *
 * - `fixed`: `base`
 * - `exponential`: `base * 2^attempts` (so the first retry waits `2 * base`); `0` when `base` is 0,
 *   whatever the attempt count
 *
 * With `jitter` on, as upstream always does: `fixed` is multiplied by `0.8 + 0.4 * random()` (plus
 * or minus 20%) and `exponential` by `0.5 + random()` (plus or minus 50%). Either way the result
 * is capped, then rounded up. A base that is NaN, negative or not a number is 1000 ms, and an
 * infinite base is capped.
 */
export function retryDelayMs(
  backoff: StoredBackoff,
  attempts: number,
  policy: BackoffPolicy = NO_JITTER
): number {
  const cap = usableCap(backoff.maxDelay);
  const base = usableBase(backoff.delay);
  let delay: number;
  if (backoff.type === 'fixed') {
    delay = base * (policy.jitter ? 0.8 + policy.random() * 0.4 : 1);
  } else if (base === 0) {
    return 0;
  } else {
    const exponent = attempts > 0 ? Math.min(attempts, MAX_EXPONENT) : 0;
    delay = base * 2 ** exponent * (policy.jitter ? 0.5 + policy.random() : 1);
  }
  return Math.ceil(Math.min(delay, cap));
}
