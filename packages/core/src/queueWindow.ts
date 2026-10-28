import { UnsupportedOptionError } from './errors';
import { isPlainObject } from './webhookFilter';
import { validateSchedule } from './webhookSchedule';

/**
 * When a queue may start jobs (DESIGN.md D17): a cron expression says when it opens, `durationMs` how long it stays
 * open, in the zone. Outside the window a claim finds nothing and the jobs wait; a job that is running when the window
 * closes finishes. The window is checked when a worker claims, so it is not a promise to the second: the tick moves the
 * window on and rings the queue when it opens, which takes up to one tick interval.
 */
export const MIN_WINDOW_MS = 60_000;
export const MAX_WINDOW_MS = 7 * 24 * 3_600_000;

export interface QueueRunWindow {
  /** Five or six fields, or a shortcut such as `@daily`. When it fires, the window opens. */
  readonly cron: string;
  /** How long it stays open, in milliseconds. */
  readonly durationMs: number;
  /** An IANA zone name. Default `UTC`. */
  readonly timezone: string;
}

/** What a caller sends: the zone may be left out. */
export type QueueRunWindowInput = Omit<QueueRunWindow, 'timezone'> & { readonly timezone?: string };

/** A window and where it stands now: the interval that is open, or the next one to open. */
export interface QueueRunWindowState extends QueueRunWindow {
  readonly open: boolean;
  /** Epoch milliseconds. */
  readonly opensAt: number;
  readonly closesAt: number;
}

/** The window with its cron trimmed and the zone defaulted. Throws `UnsupportedOptionError` naming the field. */
export function validateRunWindow(value: unknown): QueueRunWindow {
  if (!isPlainObject(value)) {
    throw new UnsupportedOptionError(
      'runWindow',
      'must be an object with cron, durationMs and optional timezone'
    );
  }
  const { durationMs, ...schedule } = value;
  const checked = validateSchedule(schedule, 'runWindow');
  if (checked === null) throw new UnsupportedOptionError('runWindow', 'must have a cron');
  if (
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_WINDOW_MS ||
    durationMs > MAX_WINDOW_MS
  ) {
    throw new UnsupportedOptionError(
      'durationMs',
      `must be a whole number of milliseconds from ${MIN_WINDOW_MS} (1 minute) to ${MAX_WINDOW_MS} (7 days)`
    );
  }
  return { cron: checked.cron, durationMs, timezone: checked.timezone };
}
