/**
 * Cron expression parser, ported from Qelay's `cronParser.ts` (see docs/PORTING.md).
 * Parses 5-field and 6-field (leading seconds) expressions and finds the next run with `Bun.cron`.
 * Every function takes its time from the caller: the store passes the operation's `now`, so a test
 * with a manual clock and a store on the database clock agree.
 */

const CRON_FIELD_COUNT = 5;
const CRON_WITH_SECONDS_FIELD_COUNT = 6;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

interface ParsedCronExpression {
  calendar: string;
  seconds: readonly number[] | null;
}

function invalidSeconds(field: string, reason: string): never {
  throw new TypeError(`Invalid cron seconds field "${field}": ${reason}`);
}

function parseNumber(value: string, field: string, label: string): number {
  if (!/^\d+$/.test(value)) invalidSeconds(field, `${label} must be an integer`);
  return Number(value);
}

/** Parse the leading seconds field supported by qcloud's six-field contract. */
function parseSeconds(field: string): number[] {
  const selected = new Set<number>();
  for (const segment of field.split(',')) {
    if (!segment) invalidSeconds(field, 'list entries cannot be empty');
    const stepParts = segment.split('/');
    if (stepParts.length > 2 || !stepParts[0] || stepParts[1] === '') {
      invalidSeconds(field, `invalid segment "${segment}"`);
    }

    const base = stepParts[0];
    const hasStep = stepParts.length === 2;
    const step = hasStep ? parseNumber(stepParts[1], field, 'step') : 1;
    if (step < 1 || step > 60) invalidSeconds(field, 'step must be between 1 and 60');

    let start: number;
    let end: number;
    if (base === '*') {
      start = 0;
      end = 59;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2 || !range[0] || !range[1]) {
        invalidSeconds(field, `invalid range "${base}"`);
      }
      start = parseNumber(range[0], field, 'range start');
      end = parseNumber(range[1], field, 'range end');
    } else {
      if (hasStep) {
        invalidSeconds(field, 'steps require a wildcard or range');
      }
      start = parseNumber(base, field, 'value');
      end = start;
    }

    if (start < 0 || start > 59 || end < 0 || end > 59) {
      invalidSeconds(field, 'values must be between 0 and 59');
    }
    if (start > end) invalidSeconds(field, 'range start must not exceed range end');
    for (let value = start; value <= end; value += step) selected.add(value);
  }
  return [...selected].sort((a, b) => a - b);
}

function parseCronExpression(expression: string): ParsedCronExpression {
  const trimmed = expression.trim();
  if (trimmed.startsWith('@') && !/\s/.test(trimmed)) {
    return { calendar: trimmed, seconds: null };
  }

  const fields = trimmed ? trimmed.split(/\s+/) : [];
  if (fields.length === CRON_FIELD_COUNT) {
    return { calendar: fields.join(' '), seconds: null };
  }
  if (fields.length === CRON_WITH_SECONDS_FIELD_COUNT) {
    return { calendar: fields.slice(1).join(' '), seconds: parseSeconds(fields[0]) };
  }
  throw new TypeError('Cron expression must have 5 fields, or 6 fields with leading seconds');
}

function parseNativeCron(calendar: string, fromTime: number, timezone?: string): Date | null {
  return Bun.cron.parse(calendar, fromTime, timezone ? { tz: timezone } : undefined);
}

function getNextParsedRun(
  parsed: ParsedCronExpression,
  fromTime: number,
  timezone?: string
): number {
  if (parsed.seconds === null) {
    return parseNativeCron(parsed.calendar, fromTime, timezone)?.getTime() ?? 0;
  }

  const currentMinute = Math.floor(fromTime / MINUTE_MS) * MINUTE_MS;
  let matchingMinute = parseNativeCron(parsed.calendar, currentMinute - 1, timezone);
  while (matchingMinute) {
    const minuteStart = matchingMinute.getTime();
    for (const second of parsed.seconds) {
      const candidate = minuteStart + second * SECOND_MS;
      if (candidate > fromTime) return candidate;
    }

    const nextMinute = parseNativeCron(parsed.calendar, minuteStart, timezone);
    if (!nextMinute || nextMinute.getTime() <= minuteStart) return 0;
    matchingMinute = nextMinute;
  }
  return 0;
}

/**
 * Validates a cron expression: 5 or 6 fields, a known time zone, and at least one occurrence after `from`.
 * @param from - The time to look forward from (the caller's `now`)
 * @param timezone - Optional IANA timezone (e.g., "Europe/Rome")
 * @returns null if valid, error message if invalid
 */
export function validateCronExpression(
  expression: string,
  from: number,
  timezone?: string
): string | null {
  try {
    const parsed = parseCronExpression(expression);
    if (getNextParsedRun(parsed, from, timezone) === 0) {
      return 'Cron expression has no future occurrences';
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}

/**
 * The first occurrence strictly after `fromTime`, in milliseconds. 0 when there is none; a bad
 * expression or time zone throws.
 */
export function getNextCronRun(expression: string, fromTime: number, timezone?: string): number {
  return getNextParsedRun(parseCronExpression(expression), fromTime, timezone);
}

/** The next run of a fixed-interval schedule. */
export function getNextIntervalRun(intervalMs: number, lastRun: number): number {
  return lastRun + intervalMs;
}

/**
 * Parse common cron shortcuts
 */
export const CRON_SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * Expand cron shortcut to full expression
 */
export function expandCronShortcut(expression: string): string {
  const trimmed = expression.trim().toLowerCase();
  return CRON_SHORTCUTS[trimmed] ?? expression;
}

/**
 * Get human-readable description of cron schedule
 */
export function describeCron(expression: string): string {
  const expanded = expandCronShortcut(expression);
  const rawParts = expanded.trim().split(/\s+/);
  const hasSeconds = rawParts.length === CRON_WITH_SECONDS_FIELD_COUNT;
  const secondsField = hasSeconds ? rawParts[0] : null;
  let seconds: readonly number[] | null = null;
  if (secondsField) {
    try {
      seconds = parseSeconds(secondsField);
    } catch {
      return 'Invalid cron expression';
    }
  }
  const parts = hasSeconds ? rawParts.slice(1) : rawParts;

  if (parts.length !== CRON_FIELD_COUNT) {
    return 'Invalid cron expression';
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const everyCalendarMinute = parts.every((part) => part === '*');
  if (secondsField === '*' && everyCalendarMinute) return 'Every second';
  if (
    secondsField &&
    /^\d+$/.test(secondsField) &&
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `Every day at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${secondsField.padStart(2, '0')}`;
  }
  const usesCalendarShortcuts = seconds === null || (seconds.length === 1 && seconds[0] === 0);

  // Common patterns
  if (
    usesCalendarShortcuts &&
    minute === '0' &&
    hour === '0' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return 'Every day at midnight';
  }
  if (
    usesCalendarShortcuts &&
    minute === '0' &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return 'Every hour';
  }
  if (usesCalendarShortcuts && everyCalendarMinute) {
    return 'Every minute';
  }

  if (secondsField) {
    return `At second ${secondsField}, minute ${minute}, hour ${hour} on day ${dayOfMonth} of ${month}, day of week ${dayOfWeek}`;
  }
  return `At ${minute} ${hour} on day ${dayOfMonth} of ${month}, day of week ${dayOfWeek}`;
}
