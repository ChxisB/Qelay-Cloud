import { UnsupportedOptionError } from './errors';
import { isPlainObject } from './webhookFilter';

/**
 * A route's send schedule (DESIGN.md D15): its events are held until the next time the cron expression fires, in the
 * time zone, then sent. This file checks the shape and the zone. Whether the expression parses and ever fires needs the
 * store's cron parser, which core does not import (`store.webhooks` does that check).
 */

export const MAX_SCHEDULE_CRON_CHARS = 200;
export const MAX_SCHEDULE_ZONE_CHARS = 64;
export const DEFAULT_SCHEDULE_ZONE = 'UTC';

export interface WebhookSchedule {
  /** Five or six fields, or a shortcut such as `@daily`. */
  readonly cron: string;
  /** An IANA zone name. */
  readonly timezone: string;
}

// oxlint-disable-next-line no-control-regex -- the control characters are what it refuses
const hasControl = (text: string): boolean => /[\u0000-\u001f\u007f]/u.test(text);

const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The schedule with its cron trimmed and the zone defaulted, or null for none. A refusal names `option`, the field the
 * caller's schedule is in (a queue's run window uses the same shape).
 */
export function validateSchedule(value: unknown, option = 'schedule'): WebhookSchedule | null {
  if (value === undefined || value === null) return null;
  const bad = (reason: string): never => {
    throw new UnsupportedOptionError(option, reason);
  };
  if (!isPlainObject(value)) return bad('must be an object with cron and timezone');
  const extra = Object.keys(value).find((key) => key !== 'cron' && key !== 'timezone');
  if (extra !== undefined) return bad(`has an unknown key "${extra}"`);
  const { cron, timezone } = value;
  if (typeof cron !== 'string' || cron.trim() === '')
    return bad('cron must be text such as "0 0 * * *"');
  const expression = cron.trim();
  if (expression.length > MAX_SCHEDULE_CRON_CHARS || hasControl(expression)) {
    return bad(
      `cron must be at most ${MAX_SCHEDULE_CRON_CHARS} characters with no control character`
    );
  }
  if (timezone === undefined || timezone === null) {
    return { cron: expression, timezone: DEFAULT_SCHEDULE_ZONE };
  }
  if (
    typeof timezone !== 'string' ||
    timezone.length > MAX_SCHEDULE_ZONE_CHARS ||
    !knownZone(timezone)
  ) {
    return bad('timezone must be an IANA zone name such as "Europe/London"');
  }
  return { cron: expression, timezone };
}
