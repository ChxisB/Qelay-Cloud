import type { Lease } from '@qelay-cloud/core';

/**
 * How a lease length becomes a deadline. Adapted from Qelay's `leaseDeadline.ts` and
 * `timeoutRule.ts`. `lease_until` is a BIGINT, so a deadline must be a whole number of
 * milliseconds; whatever the inputs, these functions return one in [0, NEVER_EXPIRES_MS].
 */

/** The latest instant a JavaScript Date holds (year 275760): a lease that never expires. */
export const NEVER_EXPIRES_MS = 8_640_000_000_000_000;

/** `start + durationMs` as a whole-millisecond deadline, clamped to [0, never expires]. */
export function leaseDeadline(start: number, durationMs: number): number {
  const deadline = Math.ceil(start + durationMs);
  if (!(deadline > 0)) return 0;
  return deadline < NEVER_EXPIRES_MS ? deadline : NEVER_EXPIRES_MS;
}

/**
 * The lease a caller asked for, in whole milliseconds and at least 1. Anything that is not a
 * number (or is NaN) means "not specified" and takes `fallbackMs`; Infinity never expires.
 */
export function requestedLeaseMs(requested: unknown, fallbackMs: number): number {
  const value = typeof requested === 'number' && requested === requested ? requested : fallbackMs;
  return value > 1 ? Math.ceil(value) : 1;
}

/**
 * The absolute deadline of a started job's processing timeout, or null for none. An absent, 0 or
 * NaN timeout is none; the deadline is `ceil(startedAt + timeout)`, so a negative timeout is
 * already due.
 */
export function processingDeadline(timeout: number | null, startedAt: number): number | null {
  if (!timeout) return null;
  const deadline = Math.ceil(startedAt + timeout);
  return Number.isSafeInteger(deadline) ? deadline : NEVER_EXPIRES_MS;
}

export interface LeaseCaps {
  /** The job's processing timeout in ms (`qcloud_jobs.timeout`). */
  readonly timeout: number | null;
  /** The job's stall timeout in ms (the payload's `stallTimeout`). */
  readonly stallTimeout: number | undefined;
}

/**
 * The deadline a claim grants at `now`: `leaseMs` shortened to the job's stall timeout (the job
 * must heartbeat within it), never past the processing deadline of a generation starting now, and
 * never less than 1 ms, so a timeout that is already due still yields a lease the next recovery
 * scan reports as a timeout. A renewal is not shortened to the stall timeout (the heartbeat's
 * own SQL applies the processing deadline).
 */
export function claimLeaseUntil(now: number, leaseMs: number, caps: LeaseCaps): number {
  const stall =
    typeof caps.stallTimeout === 'number' && caps.stallTimeout === caps.stallTimeout
      ? caps.stallTimeout
      : null;
  const lease = stall !== null && stall < leaseMs ? stall : leaseMs;
  const deadline = leaseDeadline(now, lease > 1 ? lease : 1);
  const timeoutDeadline = processingDeadline(caps.timeout, now);
  const capped =
    timeoutDeadline === null || timeoutDeadline >= deadline
      ? deadline
      : timeoutDeadline > 0
        ? timeoutDeadline
        : 0;
  return capped > now ? capped : leaseDeadline(now, 1);
}

/** A lease with a job id and a token: anything else cannot hold a job, so no query is made for it. */
export const isWellFormedLease = (lease: Lease): boolean =>
  typeof lease?.jobId === 'string' &&
  lease.jobId !== '' &&
  typeof lease.token === 'string' &&
  lease.token !== '';
