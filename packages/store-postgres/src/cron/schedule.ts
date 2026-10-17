import { expandCronShortcut, getNextCronRun, getNextIntervalRun } from './parser';

/** The fields that say when a cron fires. */
export interface CronTiming {
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly timezone: string | null;
}

/** When a cron that was created or re-timed at `now` is first due. 0: it never is. */
export function firstRun(timing: CronTiming, now: number): number {
  if (timing.schedule !== null) {
    return getNextCronRun(expandCronShortcut(timing.schedule), now, timing.timezone ?? undefined);
  }
  return getNextIntervalRun(timing.repeatEvery!, now);
}

/**
 * When a cron that was due at `dueAt` and fires (or is skipped) at `now` is due next. 0: never.
 *
 * An occurrence that is late is not made up: a cron schedule continues from `now`, so a tick that
 * was down for an hour fires one job, not sixty. An interval continues from the occurrence it
 * missed, so a steady cadence is kept (`dueAt + interval`), unless that is already past, and then
 * it restarts from `now`.
 */
export function followingRun(timing: CronTiming, dueAt: number, now: number): number {
  if (timing.schedule !== null) return firstRun(timing, now);
  const interval = timing.repeatEvery!;
  const scheduled = getNextIntervalRun(interval, dueAt);
  return scheduled <= now ? getNextIntervalRun(interval, now) : scheduled;
}

/** True when two definitions fire at the same moments, so a re-upsert need not move `next_run`. */
export function sameTiming(a: CronTiming, b: CronTiming): boolean {
  return a.schedule === b.schedule && a.repeatEvery === b.repeatEvery && a.timezone === b.timezone;
}
