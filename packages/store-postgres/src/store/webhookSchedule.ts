import type { WebhookSchedule } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { expandCronShortcut, getNextCronRun } from '../cron/parser';

/**
 * A route's send schedule (DESIGN.md D15): the part that needs the cron parser, which core does not import. A delivery
 * made for a scheduled route is due at the first fire at or after the time it would have been due without one.
 */

/**
 * The longest wait between two fires. A schedule that fires less often than this holds events for weeks, which is more
 * likely a cron written wrong than meant, and the held rows are kept in the meantime.
 */
export const MAX_SCHEDULE_GAP_MS = 31 * 24 * 3_600_000;

/** The first fire at or after `at`, in epoch milliseconds. 0: there is none. A bad expression or zone throws. */
export const nextFire = (schedule: WebhookSchedule, at: number): number =>
  getNextCronRun(expandCronShortcut(schedule.cron), at - 1, schedule.timezone);

/**
 * Refuses, by name, a schedule the cron parser cannot read, one that never fires and one that fires less often than every
 * `MAX_SCHEDULE_GAP_MS`. The gap is measured between two fires, so the answer does not depend on today's date. A refusal
 * names `option` (a queue's run window uses the same check).
 */
export function checkSchedule(schedule: WebhookSchedule, option = 'schedule'): void {
  const refuse = (reason: string): never => {
    throw new UnsupportedOptionError(option, reason);
  };
  let first: number;
  let second: number;
  try {
    first = nextFire(schedule, Date.now());
    second = first === 0 ? 0 : nextFire(schedule, first + 1);
  } catch (error) {
    return refuse(`cron ${error instanceof Error ? error.message : 'cannot be read'}`);
  }
  if (first === 0 || second === 0) return refuse('never fires');
  if (second - first > MAX_SCHEDULE_GAP_MS) {
    refuse('must fire at least once every 31 days');
  }
}
