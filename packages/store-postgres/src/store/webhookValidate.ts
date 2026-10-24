import {
  isWebhookDestination,
  MAX_WEBHOOK_URL_CHARS,
  UnsupportedOptionError,
  validateBatch,
  validateDedupe,
  validateDelay,
  validateDescription,
  validateFilter,
  validateName,
  validateSchedule,
  validateShape,
} from '@qelay-cloud/core';
import type {
  WebhookBatch,
  WebhookDedupe,
  WebhookDestination,
  WebhookFilter,
  WebhookSchedule,
  WebhookShape,
} from '@qelay-cloud/core';
import { identifier } from './prepare';
import { checkSchedule } from './webhookSchedule';
import type { WebhookSpec } from './webhookTypes';

/** What a spec says once it has been checked: the rules of `WebhookSpec`, in the form the store writes them. */
export const MIN_SECRET_CHARS = 16;
export const MAX_SECRET_CHARS = 256;

export interface Valid {
  readonly destination: WebhookDestination;
  readonly url: string;
  readonly target: string | null;
  readonly source: string;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly delayMs: number | null;
  readonly dedupe: WebhookDedupe | null;
  readonly schedule: WebhookSchedule | null;
  readonly batch: WebhookBatch | null;
}

/** The schedule checked down to its cron (`core` checks the shape, the store reads the expression), or null for none. */
export function checkedSchedule(value: unknown): WebhookSchedule | null {
  const schedule = validateSchedule(value);
  if (schedule !== null) checkSchedule(schedule);
  return schedule;
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

export function validate(spec: WebhookSpec): Valid {
  const route = checkAddress(spec.destination ?? 'http', spec.url, spec.target);
  if (spec.source == null) throw new UnsupportedOptionError('source', 'a route needs a source');
  const secret = checkSecret(spec.secret);
  if (secret !== null && route.destination === 'queue') {
    throw new UnsupportedOptionError('secret', 'a queue route is not signed: it has no secret');
  }
  return {
    ...route,
    source: identifier('source', spec.source),
    secret,
    enabled: spec.enabled ?? true,
    filter: spec.filter == null ? null : validateFilter(spec.filter),
    shape: spec.shape == null ? null : validateShape(spec.shape),
    name: validateName(spec.name),
    description: validateDescription(spec.description),
    delayMs: validateDelay(spec.delayMs),
    dedupe: validateDedupe(spec.dedupe),
    schedule: checkedSchedule(spec.schedule),
    batch: validateBatch(spec.batch, route.destination),
  };
}
