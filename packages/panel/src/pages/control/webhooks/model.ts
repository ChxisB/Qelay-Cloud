import type { AddWebhookBody, WebhookDestination } from '@/lib/bq';

/** The signing secret's bounds, as the Control API enforces them. */
export const SECRET_MIN_CHARS = 16;
export const SECRET_MAX_CHARS = 256;

/** A fresh 256-bit secret as 64 hex characters. */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isDeliverableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      value.length <= 2_048 &&
      /^https?:$/.test(parsed.protocol) &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

export function displayWebhookUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = 'redacted';
    parsed.password = 'redacted';
    return parsed.toString();
  } catch {
    return value;
  }
}

const QUEUE_NAME = /^[a-zA-Z0-9_\-.:]+$/;
export const QUEUE_NAME_MSG = 'must be at most 256 characters using letters, numbers, _, -, . or :';
export const validQueue = (name: string): boolean => name.length <= 256 && QUEUE_NAME.test(name);

/**
 * What the Add connection form sends. An `http` route needs a deliverable address; a `queue` route
 * needs the queue whose events it hears and the queue it adds jobs to, and has no address or secret.
 */
export function buildWebhookBody(
  url: string,
  events: string[],
  queue: string,
  secret: string,
  route: { destination: WebhookDestination; target: string } = { destination: 'http', target: '' }
): { ok: true; body: AddWebhookBody } | { ok: false; msg: string } {
  const normalizedQueue = queue.trim();
  if (route.destination === 'queue') {
    const target = route.target.trim();
    if (!normalizedQueue || !target || events.length === 0) {
      return {
        ok: false,
        msg: 'A source queue, a target queue and at least one event are required',
      };
    }
    if (!validQueue(normalizedQueue) || !validQueue(target)) {
      return { ok: false, msg: `Queue names ${QUEUE_NAME_MSG}` };
    }
    return { ok: true, body: { destination: 'queue', queue: normalizedQueue, target, events } };
  }
  const normalizedUrl = url.trim();
  if (!normalizedUrl || events.length === 0) {
    return { ok: false, msg: 'URL and at least one event are required' };
  }
  if (!isDeliverableUrl(normalizedUrl)) {
    return {
      ok: false,
      msg: 'URL must be a valid http:// or https:// address without embedded credentials',
    };
  }
  if (normalizedQueue && !validQueue(normalizedQueue)) {
    return { ok: false, msg: `Queue ${QUEUE_NAME_MSG}` };
  }
  const normalizedSecret = secret.trim();
  if (
    normalizedSecret &&
    (normalizedSecret.length < SECRET_MIN_CHARS || normalizedSecret.length > SECRET_MAX_CHARS)
  ) {
    return {
      ok: false,
      msg: `Secret must be ${SECRET_MIN_CHARS} to ${SECRET_MAX_CHARS} characters, or left empty for unsigned deliveries`,
    };
  }
  return {
    ok: true,
    body: {
      url: normalizedUrl,
      events,
      queue: normalizedQueue || undefined,
      secret: normalizedSecret || undefined,
    },
  };
}
