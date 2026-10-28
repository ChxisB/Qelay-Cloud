import { UnsupportedOptionError } from './errors';
import { isJsonContentType } from './inboundSource';
import { isPlainObject } from './webhookFilter';
import type { WebhookDestination } from './webhookRoute';

/**
 * A route's batch (DESIGN.md D15): the sender takes up to `maxEvents` of its due deliveries and sends them as ONE
 * request, `{ batchId, count, events: [{ id, receivedAt, body }] }`. This file is the part that needs no I/O: the limits
 * and the envelope. Which deliveries go together is `claimDueDeliveries`' (the store); the request is the sender's.
 */

/** `X-Webhook-Event` of a batch request: it carries many events, so it names none of them. */
export const WEBHOOK_BATCH_EVENT = 'webhook.batch';

export const MIN_BATCH_EVENTS = 1;
export const MAX_BATCH_EVENTS = 500;
export const DEFAULT_BATCH_EVENTS = 100;
export const MIN_BATCH_BYTES = 1_024;
export const MAX_BATCH_BYTES = 1_048_576;
export const DEFAULT_BATCH_BYTES = 262_144;

export interface WebhookBatch {
  /** Most events in one request. */
  readonly maxEvents: number;
  /**
   * Most bytes of event bodies in one request. One event larger than this still goes, alone: the limit stops a batch
   * from growing, it does not refuse an event.
   */
  readonly maxBytes: number;
}

const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** The batch with its defaults filled in, or null for none. Only an `http` route sends in batches. */
export function validateBatch(
  value: unknown,
  destination: WebhookDestination = 'http'
): WebhookBatch | null {
  if (value === undefined || value === null) return null;
  const bad = (reason: string): never => {
    throw new UnsupportedOptionError('batch', reason);
  };
  if (destination !== 'http') {
    return bad('is only for an http route: a queue route adds one job per event already');
  }
  if (!isPlainObject(value)) return bad('must be an object with maxEvents and maxBytes');
  const extra = Object.keys(value).find((key) => key !== 'maxEvents' && key !== 'maxBytes');
  if (extra !== undefined) return bad(`has an unknown key "${extra}"`);
  const { maxEvents = DEFAULT_BATCH_EVENTS, maxBytes = DEFAULT_BATCH_BYTES } = value;
  if (!whole(maxEvents, MIN_BATCH_EVENTS, MAX_BATCH_EVENTS)) {
    return bad(`maxEvents must be a whole number from ${MIN_BATCH_EVENTS} to ${MAX_BATCH_EVENTS}`);
  }
  if (!whole(maxBytes, MIN_BATCH_BYTES, MAX_BATCH_BYTES)) {
    return bad(`maxBytes must be a whole number from ${MIN_BATCH_BYTES} to ${MAX_BATCH_BYTES}`);
  }
  return { maxEvents, maxBytes };
}

/** One event of a batch, as the sender holds it. */
export interface BatchEvent {
  /** The delivery id: stable across attempts, so a receiver can de-duplicate on it. */
  readonly id: string;
  /** When the request was taken, epoch milliseconds. */
  readonly receivedAt: number;
  /** A shaped body (JSON text), a request's own bytes, or null when it has none. */
  readonly body: string | Uint8Array | null;
  /** The request's content type; unused for a shaped body. */
  readonly contentType: string | null;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// btoa on a spread would pass one argument per byte and overflow the stack on a large body, so go in slices.
const toBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8_192) {
    text += String.fromCharCode(...bytes.subarray(at, at + 8_192));
  }
  return btoa(text);
};

/**
 * The batch's id: a SHA-256 of its members' ids, sorted. The same members give the same id on a retry, so a receiver
 * that saw the first request can drop the second. One more or one fewer member gives another id.
 */
export async function batchId(ids: readonly string[]): Promise<string> {
  const text = JSON.stringify([...ids].sort());
  return toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  );
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A JSON body nested as JSON; other text as a string; bytes that are not UTF-8 as `{ base64 }`; no body as null. */
export function batchEventBody(event: BatchEvent): unknown {
  const { body } = event;
  if (body === null) return null;
  if (typeof body === 'string') return parseOr(body, true);
  if (body.length === 0) return null;
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return { base64: toBase64(body) };
  }
  return parseOr(text, isJsonContentType(event.contentType));
}

function parseOr(text: string, json: boolean): unknown {
  if (!json) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The JSON text that is POSTed and signed for a batch. The events keep the order given. */
export async function buildBatchBody(events: readonly BatchEvent[]): Promise<string> {
  return JSON.stringify({
    batchId: await batchId(events.map((event) => event.id)),
    count: events.length,
    events: events.map((event) => ({
      id: event.id,
      receivedAt: event.receivedAt,
      body: batchEventBody(event),
    })),
  });
}
