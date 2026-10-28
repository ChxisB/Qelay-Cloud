import type { WebhookFull } from '@/lib/bqTypes';
import { cronLabel, inZone } from './sendRules';

// The three numbers below are the deployment defaults of docs/webhooks.md (QCLOUD_WEBHOOK_MAX_ATTEMPTS and
// _BASE_DELAY_MS, _RATE_PER_MINUTE, _DISABLE_AFTER). No read returns them, so a deployment that sets its own
// shows these words wrongly; gateway-connection-settings.test.tsx keeps them equal to the guide.
export const RETRY_WORDS =
  'After a failed attempt, again after 30 seconds, then 1, 2, 4, 8, 16 and 32 minutes: 8 attempts in all.';
export const RATE_PER_MINUTE = 60;
export const PAUSE_AFTER = 20;

/** The rules that are the same for every connection, as the short phrase the hover card ends with. */
export const FIXED_LABELS: Record<string, string> = {
  Retry: 'Retry, 8 attempts',
  'Rate limit': `Rate limit, ${RATE_PER_MINUTE} a minute`,
  'Auto-pause': `Auto-pause, after ${PAUSE_AFTER} failures`,
};

export interface RuleCard {
  name: string;
  on: boolean;
  /** Set on this connection (and so edited in the form) rather than the same for every connection. */
  editable: boolean;
  summary: string;
  /** The rule as the server holds it, for a filter or a shape. */
  code?: string;
}

/** 90000 → "90 seconds", 3600000 → "1 hour": whole units only, so a span reads the way it was typed. */
export function spanWords(ms: number): string {
  const [unit, size]: [string, number] =
    ms % 3_600_000 === 0
      ? ['hour', 3_600_000]
      : ms % 60_000 === 0
        ? ['minute', 60_000]
        : ['second', 1_000];
  const n = ms / size;
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function batchCard(route: WebhookFull): RuleCard {
  const batch = route.batch;
  return {
    name: 'Batch',
    editable: true,
    on: batch !== null,
    summary: batch
      ? `Events due together go out as one request of up to ${batch.maxEvents} events or ${batch.maxBytes / 1_024} KiB, and are retried together.`
      : 'Off: each event is sent in its own request.',
  };
}

/** What an event goes through on its way out, in order: the connection's rules as cards. */
export function ruleCards(route: WebhookFull): RuleCard[] {
  return [
    {
      name: 'Filter',
      editable: true,
      on: route.filter !== null,
      summary: route.filter
        ? 'Only events that match this are sent.'
        : 'Off: every event of the source is sent.',
      ...(route.filter ? { code: JSON.stringify(route.filter, null, 2) } : {}),
    },
    {
      name: 'Deduplicate',
      editable: true,
      on: route.dedupe !== null,
      summary: route.dedupe
        ? `An event that repeats its ${route.dedupe.fields.join(', ')} within ${spanWords(route.dedupe.windowMs)} of one already sent is dropped.`
        : 'Off: every event is sent, repeats included.',
    },
    {
      name: 'Shape',
      editable: true,
      on: route.shape !== null,
      summary: route.shape
        ? 'The body sent is built from this.'
        : 'Off: the standard body is sent.',
      ...(route.shape ? { code: JSON.stringify(route.shape, null, 2) } : {}),
    },
    {
      name: 'Delay',
      editable: true,
      on: route.delayMs !== null,
      summary: route.delayMs
        ? `Each event waits ${spanWords(route.delayMs)} before it is sent.`
        : 'Off: an event is sent as soon as it happens.',
    },
    {
      name: 'Schedule',
      editable: true,
      on: route.schedule !== null,
      summary: route.schedule
        ? `${cronLabel(route.schedule.cron)}, in ${route.schedule.timezone}. ${
            route.nextSendAt === null
              ? 'It has no next send time.'
              : `Next send ${inZone(route.nextSendAt, route.schedule.timezone)}.`
          }`
        : 'Off: an event is sent as soon as it is due.',
    },
    ...(route.destination === 'http' ? [batchCard(route)] : []),
    {
      name: 'Rate limit',
      editable: false,
      on: true,
      summary: `At most ${RATE_PER_MINUTE} attempts a minute; the rest wait their turn.`,
    },
    { name: 'Retry', editable: false, on: true, summary: RETRY_WORDS },
    {
      name: 'Auto-pause',
      editable: false,
      on: true,
      summary: `Paused after ${PAUSE_AFTER} failed events in a row. Resume it once the receiver works.`,
    },
  ];
}
