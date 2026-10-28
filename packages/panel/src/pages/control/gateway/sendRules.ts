import type { WebhookBatchFull, WebhookPatchBody, WebhookScheduleFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';

// The limits of docs/webhooks.md (D15). The server checks them too; the form says so before the round trip.
export const CRON_MAX = 200;
export const ZONE_MAX = 64;
export const BATCH_EVENTS_DEFAULT = 100;
export const BATCH_EVENTS_MAX = 500;
export const BATCH_KIB_DEFAULT = 256;
export const BATCH_KIB_MAX = 1_024;

/** `sendMode` for an event that goes as soon as it is taken, and for a cron the person writes. */
export const SEND_NOW = '';
export const SEND_CUSTOM = 'custom';

/** The times most routes want. The select's value is the cron itself, so a saved route finds its own label. */
export const SEND_PRESETS: readonly { cron: string; label: string }[] = [
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 0 * * *', label: 'Every night at midnight' },
  { cron: '0 0 * * 1', label: 'Every Monday at midnight' },
];

/** What the form holds for when and how events are sent: as typed, so a refusal can keep it. */
export interface SendFields {
  /** `SEND_NOW`, one of the `SEND_PRESETS` crons, or `SEND_CUSTOM`. */
  sendMode: string;
  /** The cron of `SEND_CUSTOM`; ignored otherwise. */
  sendCron: string;
  /** An IANA zone name; ignored while events go at once. */
  sendZone: string;
  batchOn: boolean;
  /** Empty is the default, `BATCH_EVENTS_DEFAULT`. */
  batchEvents: string;
  /** Kibibytes; empty is the default, `BATCH_KIB_DEFAULT`. */
  batchKib: string;
}

export type SendField = keyof SendFields;

export type SendResult =
  | { ok: true; patch: Pick<WebhookPatchBody, 'schedule' | 'batch'> }
  | { ok: false; field: SendField; msg: string };

export type SendRoute = Pick<WebhookFull, 'schedule' | 'batch'>;

export function sendFieldsOf(route: SendRoute): SendFields {
  const cron = route.schedule?.cron ?? '';
  const preset = SEND_PRESETS.some((item) => item.cron === cron);
  return {
    sendMode: route.schedule === null ? SEND_NOW : preset ? cron : SEND_CUSTOM,
    sendCron: preset ? '' : cron,
    sendZone: route.schedule?.timezone ?? 'UTC',
    batchOn: route.batch !== null,
    batchEvents: route.batch ? String(route.batch.maxEvents) : '',
    batchKib: route.batch ? String(route.batch.maxBytes / 1_024) : '',
  };
}

/** A number typed in a box between `min` and `max`; `fallback` for an empty box; null when it is neither. */
function numberOf(text: string, fallback: number, min: number, max: number): number | null {
  if (text.trim() === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** What the fields say the schedule is: null for at once, or a message about the first field that cannot be sent. */
function scheduleOf(
  fields: SendFields
): WebhookScheduleFull | null | { field: SendField; msg: string } {
  if (fields.sendMode === SEND_NOW) return null;
  const cron = fields.sendMode === SEND_CUSTOM ? fields.sendCron.trim() : fields.sendMode;
  if (cron === '') {
    return {
      field: 'sendCron',
      msg: 'Write a cron expression, like 0 0 * * * for every midnight.',
    };
  }
  if (cron.length > CRON_MAX) {
    return { field: 'sendCron', msg: `A cron expression is at most ${CRON_MAX} characters.` };
  }
  const timezone = fields.sendZone.trim();
  if (timezone === '' || timezone.length > ZONE_MAX) {
    return { field: 'sendZone', msg: 'Choose a time zone.' };
  }
  return { cron, timezone };
}

function batchOf(fields: SendFields): WebhookBatchFull | null | { field: SendField; msg: string } {
  if (!fields.batchOn) return null;
  const events = numberOf(fields.batchEvents, BATCH_EVENTS_DEFAULT, 1, BATCH_EVENTS_MAX);
  if (events === null || !Number.isInteger(events)) {
    return {
      field: 'batchEvents',
      msg: `Events per request is a whole number from 1 to ${BATCH_EVENTS_MAX}.`,
    };
  }
  const kib = numberOf(fields.batchKib, BATCH_KIB_DEFAULT, 1, BATCH_KIB_MAX);
  if (kib === null) {
    return {
      field: 'batchKib',
      msg: `Size is a number of KiB from 1 to ${BATCH_KIB_MAX.toLocaleString('en')}.`,
    };
  }
  return { maxEvents: events, maxBytes: Math.round(kib * 1_024) };
}

const refusal = (value: object): value is { field: SendField; msg: string } => 'field' in value;

/** The `schedule` and `batch` keys that turn the route into what the fields hold: only the ones that changed. */
export function sendPatchOf(route: SendRoute, fields: SendFields): SendResult {
  const patch: { schedule?: WebhookScheduleFull | null; batch?: WebhookBatchFull | null } = {};
  const schedule = scheduleOf(fields);
  if (schedule !== null && refusal(schedule)) return { ok: false, ...schedule };
  const was = route.schedule;
  if (
    schedule === null
      ? was !== null
      : was === null || was.cron !== schedule.cron || was.timezone !== schedule.timezone
  ) {
    patch.schedule = schedule;
  }

  const batch = batchOf(fields);
  if (batch !== null && refusal(batch)) return { ok: false, ...batch };
  const had = route.batch;
  if (
    batch === null
      ? had !== null
      : had === null || had.maxEvents !== batch.maxEvents || had.maxBytes !== batch.maxBytes
  ) {
    patch.batch = batch;
  }
  return { ok: true, patch };
}

/** The time zones to choose from, with `current` kept in the list when this browser does not know it. */
export function zoneNames(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set(['UTC', ...known, current])];
}

/** This browser's own zone, which is where a person is most likely to mean "midnight". */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A cron as words: a preset's label, else the expression. */
export const cronLabel = (cron: string): string =>
  SEND_PRESETS.find((item) => item.cron === cron)?.label ?? `Cron ${cron}`;

/** A moment as the schedule's own zone shows it, like `Sat 16 Jan, 00:00 GMT`; the plain ISO text if the zone is unknown here. */
export function inZone(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}
