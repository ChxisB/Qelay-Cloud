import {
  isWebhookDestination,
  isWebhookEvent,
  MAX_WEBHOOK_URL_CHARS,
  UnsupportedOptionError,
  validateDedupe,
  validateDelay,
  validateDescription,
  validateFilter,
  validateName,
  validateShape,
  WEBHOOK_EVENTS,
} from '@qelay-cloud/core';
import type {
  WebhookDedupe,
  WebhookDestination,
  WebhookFilter,
  WebhookShape,
} from '@qelay-cloud/core';
import { identifier } from './prepare';
import type { WebhookSpec } from './webhookTypes';

/** What a spec says once it has been checked: the rules of `WebhookSpec`, in the form the store writes them. */
export const MIN_SECRET_CHARS = 16;
export const MAX_SECRET_CHARS = 256;

export interface Valid {
  readonly destination: WebhookDestination;
  readonly url: string;
  readonly target: string | null;
  readonly events: string[];
  readonly queue: string | null;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly delayMs: number | null;
  readonly dedupe: WebhookDedupe | null;
}

/** The secret as given (null for none), or `UnsupportedOptionError('secret', …)`. */
export function checkSecret(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < MIN_SECRET_CHARS ||
    value.length > MAX_SECRET_CHARS
  ) {
    throw new UnsupportedOptionError(
      'secret',
      `must be ${MIN_SECRET_CHARS} to ${MAX_SECRET_CHARS} characters`
    );
  }
  return value;
}

/** An address as a route and a saved destination both have it: `http` has a `url`, `queue` a `target`; nothing else. */
export function checkAddress(
  destination: unknown,
  url: string | null | undefined,
  target: string | null | undefined
): Pick<Valid, 'destination' | 'url' | 'target'> {
  if (!isWebhookDestination(destination)) {
    throw new UnsupportedOptionError('destination', 'must be http or queue');
  }
  if (destination === 'queue') {
    if (url != null && url !== '') {
      throw new UnsupportedOptionError('url', 'a queue destination has no url');
    }
    if (target == null) {
      throw new UnsupportedOptionError('target', 'a queue destination needs a target queue');
    }
    return { destination, url: '', target: identifier('target', target) };
  }
  if (target != null) {
    throw new UnsupportedOptionError('target', 'only a queue destination has a target');
  }
  if (typeof url !== 'string' || url === '' || url.length > MAX_WEBHOOK_URL_CHARS) {
    throw new UnsupportedOptionError(
      'url',
      `must be a string of 1 to ${MAX_WEBHOOK_URL_CHARS} characters`
    );
  }
  if (url.includes('\0')) throw new UnsupportedOptionError('url', 'must not contain NUL');
  return { destination, url, target: null };
}

/** The address and queue of a route: a `queue` route also needs a source queue. */
function validateDestination(spec: WebhookSpec): Pick<Valid, 'destination' | 'url' | 'target'> {
  const destination = spec.destination ?? 'http';
  if (destination === 'queue' && spec.queue == null) {
    throw new UnsupportedOptionError('queue', 'a queue route needs a source queue');
  }
  return checkAddress(destination, spec.url, spec.target);
}

/** The events as a list without repeats, or `UnsupportedOptionError('events', …)`. */
export function checkEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new UnsupportedOptionError(
      'events',
      `must name at least one of ${WEBHOOK_EVENTS.join(', ')}`
    );
  }
  for (const event of events) {
    if (!isWebhookEvent(event)) {
      throw new UnsupportedOptionError('events', `unknown event; use ${WEBHOOK_EVENTS.join(', ')}`);
    }
  }
  return [...new Set<string>(events)];
}

export function validate(spec: WebhookSpec): Valid {
  const route = validateDestination(spec);
  const events = checkEvents(spec.events);
  const secret = checkSecret(spec.secret);
  if (secret !== null && route.destination === 'queue') {
    throw new UnsupportedOptionError('secret', 'a queue route is not signed: it has no secret');
  }
  return {
    ...route,
    events,
    queue: spec.queue == null ? null : identifier('queue', spec.queue),
    secret,
    enabled: spec.enabled ?? true,
    filter: spec.filter == null ? null : validateFilter(spec.filter),
    shape: spec.shape == null ? null : validateShape(spec.shape),
    name: validateName(spec.name),
    description: validateDescription(spec.description),
    delayMs: validateDelay(spec.delayMs),
    dedupe: validateDedupe(spec.dedupe),
  };
}

/** The first rule a route has that only the delivery writer applies (the trigger cannot), by its option name; null for none. */
export const needsWriter = (
  rules: Pick<Valid, 'filter' | 'shape' | 'delayMs' | 'dedupe'>
): 'filter' | 'shape' | 'delayMs' | 'dedupe' | null =>
  rules.filter !== null
    ? 'filter'
    : rules.shape !== null
      ? 'shape'
      : rules.delayMs !== null
        ? 'delayMs'
        : rules.dedupe !== null
          ? 'dedupe'
          : null;
