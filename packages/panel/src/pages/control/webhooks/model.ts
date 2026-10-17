import type { AddWebhookBody } from '@/lib/bq';

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

export function buildWebhookBody(
  url: string,
  events: string[],
  queue: string,
  secret: string
): { ok: true; body: AddWebhookBody } | { ok: false; msg: string } {
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
  const normalizedQueue = queue.trim();
  if (
    normalizedQueue &&
    (normalizedQueue.length > 256 || !/^[a-zA-Z0-9_\-.:]+$/.test(normalizedQueue))
  ) {
    return {
      ok: false,
      msg: 'Queue must be at most 256 characters using letters, numbers, _, -, . or :',
    };
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
