import { UnsupportedOptionError } from './errors';
import type { WebhookSubject } from './webhookFilter';
import { isPlainObject } from './webhookFilter';

/**
 * The rules a connection can have beside `filter` and `shape` (D13): a name, a delay and a dedupe. All of
 * them are data. Delay and dedupe are applied by the delivery writer, so they need it on, as a filter does.
 */

export const WEBHOOK_NAME_CHARS = 80;
export const WEBHOOK_DESCRIPTION_CHARS = 500;
export const MIN_WEBHOOK_DELAY_MS = 1_000;
export const MAX_WEBHOOK_DELAY_MS = 60 * 60 * 1000;
export const MIN_DEDUPE_WINDOW_MS = 1_000;
export const MAX_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The `disabled_reason` of a route an operator paused with `hold`: it is off and still collects events, and it is not an issue. */
export const WEBHOOK_HOLD_REASON = 'paused by an operator';

/**
 * How an operator pauses a route. `hold`: it stops sending and keeps collecting events, which go out when it is resumed.
 * `ignore`: it stops sending and collects nothing.
 */
export const WEBHOOK_PAUSE_MODES = ['hold', 'ignore'] as const;
export type WebhookPauseMode = (typeof WEBHOOK_PAUSE_MODES)[number];

/** Who paused a route that is off and collecting: an operator (`hold`), or the failure streak (auto-pause). Null: not holding. */
export const webhookPausedBy = (route: {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
}): 'operator' | 'failures' | null =>
  route.enabled || route.disabledReason === null
    ? null
    : route.disabledReason === WEBHOOK_HOLD_REASON
      ? 'operator'
      : 'failures';

/** The fields two events can be compared on: those of a job event that name what happened, not when. */
export const DEDUPE_FIELDS = ['event', 'queue', 'jobId', 'state', 'error'] as const;
export type DedupeField = (typeof DEDUPE_FIELDS)[number];

/** Of the events a route accepts, the first with these values goes; the same values inside `windowMs` are dropped. */
export interface WebhookDedupe {
  readonly windowMs: number;
  readonly fields: readonly DedupeField[];
}

const hasControl = (text: string, allowNewline: boolean): boolean => {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (allowNewline && (code === 10 || code === 13 || code === 9)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

function text(option: string, value: unknown, max: number, allowNewline: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new UnsupportedOptionError(option, 'must be text');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw new UnsupportedOptionError(option, `must be at most ${max} characters`);
  }
  if (hasControl(trimmed, allowNewline)) {
    throw new UnsupportedOptionError(option, 'must not contain control characters');
  }
  return trimmed;
}

/** The name trimmed, or null for none (null, undefined and blank clear it). */
export const validateName = (value: unknown): string | null =>
  text('name', value, WEBHOOK_NAME_CHARS, false);

export const validateDescription = (value: unknown): string | null =>
  text('description', value, WEBHOOK_DESCRIPTION_CHARS, true);

/** The delay in milliseconds, or null for none. */
export function validateDelay(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_WEBHOOK_DELAY_MS ||
    value > MAX_WEBHOOK_DELAY_MS
  ) {
    throw new UnsupportedOptionError(
      'delayMs',
      `must be a whole number of milliseconds from ${MIN_WEBHOOK_DELAY_MS} to ${MAX_WEBHOOK_DELAY_MS}`
    );
  }
  return value;
}

const isDedupeField = (name: unknown): name is DedupeField =>
  (DEDUPE_FIELDS as readonly unknown[]).includes(name);

/** A dedupe with its fields in `DEDUPE_FIELDS` order and none twice, or null for none. */
export function validateDedupe(value: unknown): WebhookDedupe | null {
  if (value === undefined || value === null) return null;
  const bad = (reason: string): never => {
    throw new UnsupportedOptionError('dedupe', reason);
  };
  if (!isPlainObject(value)) return bad('must be an object with windowMs and fields');
  const extra = Object.keys(value).find((key) => key !== 'windowMs' && key !== 'fields');
  if (extra !== undefined) return bad(`has an unknown key "${extra}"`);
  const { windowMs, fields } = value;
  if (
    typeof windowMs !== 'number' ||
    !Number.isInteger(windowMs) ||
    windowMs < MIN_DEDUPE_WINDOW_MS ||
    windowMs > MAX_DEDUPE_WINDOW_MS
  ) {
    return bad(`windowMs must be from ${MIN_DEDUPE_WINDOW_MS} to ${MAX_DEDUPE_WINDOW_MS}`);
  }
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isDedupeField)) {
    return bad(`fields must name at least one of ${DEDUPE_FIELDS.join(', ')}`);
  }
  return { windowMs, fields: DEDUPE_FIELDS.filter((field) => fields.includes(field)) };
}

/** What two events must share to be the same: the chosen fields' values, as text. A missing value is null, not "null". */
export const dedupeValues = (fields: readonly DedupeField[], subject: WebhookSubject): string =>
  JSON.stringify(fields.map((field) => subject[field] ?? null));
