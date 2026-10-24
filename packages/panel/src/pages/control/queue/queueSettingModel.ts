import type { QueuePolicy, QueueRunWindow, QueueRunWindowInput } from '@/lib/bqTypes';
import type { ConfigValidation } from './configModel';

const SECOND = 1000;
const HOUR = 3_600_000;
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 7 * 24 * HOUR;
const MAX_BACKOFF_MS = 86_400_000;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** A length of time in the largest unit that reads whole or with one decimal: "30 seconds", "1.5 hours", "2 days". */
export function spell(ms: number): string {
  const units: Array<[number, string]> = [
    [24 * HOUR, 'day'],
    [HOUR, 'hour'],
    [60_000, 'minute'],
    [SECOND, 'second'],
  ];
  for (const [size, name] of units) {
    if (ms >= size) return plural(Math.round((ms / size) * 10) / 10, name);
  }
  return plural(ms, 'millisecond');
}

// ---- Retry policy ----

/** What the policy form holds: seconds as typed, and the backoff kind (empty is none). */
export interface PolicyDraft {
  attempts: string;
  backoff: '' | 'fixed' | 'exponential';
  delay: string;
  maxDelay: string;
  timeout: string;
}

const seconds = (ms: number | undefined) => (ms === undefined ? '' : String(ms / SECOND));

export const policyDraft = (policy: QueuePolicy | null): PolicyDraft => ({
  attempts: policy?.attempts === undefined ? '' : String(policy.attempts),
  backoff: policy?.backoff?.type ?? '',
  delay: seconds(policy?.backoff?.delay),
  maxDelay: seconds(policy?.backoff?.maxDelay),
  timeout: seconds(policy?.timeout),
});

/** Seconds as typed to whole milliseconds, or null when it is not a number from `min` up to `max`. */
function toMs(raw: string, min: number, max: number): number | null {
  const ms = Math.round(Number(raw) * SECOND);
  return raw.trim() !== '' && Number.isSafeInteger(ms) && ms >= min && ms <= max ? ms : null;
}

/** The body `PUT /policy` takes. A blank field is left out, and a form with every field blank is `{}`, which removes it. */
export function policyPayload(draft: PolicyDraft): ConfigValidation<QueuePolicy> {
  const policy: QueuePolicy = {};
  if (draft.attempts.trim() !== '') {
    const attempts = Number(draft.attempts);
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      return { ok: false, error: 'Attempts must be a whole number, 1 or more.' };
    }
    policy.attempts = attempts;
  }
  if (draft.backoff === '') {
    if (draft.delay.trim() !== '') {
      return { ok: false, error: 'Choose how retries are spaced, or clear the delay.' };
    }
  } else {
    const delay = toMs(draft.delay, 0, MAX_BACKOFF_MS);
    if (delay === null) {
      return { ok: false, error: 'The retry delay must be a number of seconds, 0 to 86,400.' };
    }
    const max = draft.backoff === 'exponential' && draft.maxDelay.trim() !== '';
    const maxDelay = max ? toMs(draft.maxDelay, 0, MAX_BACKOFF_MS) : undefined;
    if (maxDelay === null) {
      return { ok: false, error: 'The longest delay must be a number of seconds, 0 to 86,400.' };
    }
    policy.backoff = {
      type: draft.backoff,
      delay,
      ...(maxDelay !== undefined && { maxDelay }),
    };
  }
  if (draft.timeout.trim() !== '') {
    const timeout = toMs(draft.timeout, 1, Number.MAX_SAFE_INTEGER);
    if (timeout === null) {
      return { ok: false, error: 'The time limit must be a number of seconds above 0.' };
    }
    policy.timeout = timeout;
  }
  return { ok: true, value: policy };
}

// ---- Run window ----

/** What the window form holds: the cron, hours open as typed, and the zone (blank is UTC). */
export interface WindowDraft {
  cron: string;
  hours: string;
  timezone: string;
}

export const windowDraft = (window: QueueRunWindow | null): WindowDraft => ({
  cron: window?.cron ?? '',
  hours: window ? String(window.durationMs / HOUR) : '',
  timezone: window?.timezone ?? '',
});

/** The body `PUT /run-window` takes. The server checks the cron and the zone and its message is shown as it is. */
export function windowPayload(draft: WindowDraft): ConfigValidation<QueueRunWindowInput> {
  const cron = draft.cron.trim();
  if (cron === '') {
    return { ok: false, error: 'Enter when the window opens, for example 0 0 * * * for midnight.' };
  }
  const durationMs = Math.round(Number(draft.hours) * HOUR);
  if (
    draft.hours.trim() === '' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_WINDOW_MS ||
    durationMs > MAX_WINDOW_MS
  ) {
    return { ok: false, error: 'Open for 1 minute to 7 days: 0.02 to 168 hours.' };
  }
  const timezone = draft.timezone.trim();
  return { ok: true, value: { cron, durationMs, ...(timezone !== '' && { timezone }) } };
}
