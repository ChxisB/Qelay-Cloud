import { TransportError } from '@qelay-cloud/core';

/**
 * Resource naming. A Qelay queue name is any non-empty string, a Pub/Sub resource id is 3 to 255
 * characters of `[A-Za-z0-9-_.~+%]` starting with a letter, so a name is encoded:
 *
 * - `encodeName` keeps `[A-Za-z0-9-]` and writes every other UTF-8 byte as `_` plus two lowercase
 *   hex digits. `_` and `.` are always escaped, so the encoding is injective and `.` can separate
 *   the parts of a resource id without ambiguity. A name made of letters, digits and dashes is its
 *   own encoding.
 * - `decodeName` is its inverse, and answers null for anything `encodeName` could not have made.
 *
 * ```
 * topic                  qcloud.<namespace>.bells
 * dead-letter topic      qcloud.<namespace>.bells-dlq
 * subscription           qcloud.<namespace>.sub.<queue>
 * dead-letter subscript. qcloud.<namespace>.dlq.<queue>
 * ```
 *
 * Messages carry `route = <namespace>.<queue>` (both encoded) as an attribute, and every
 * subscription filters on it (`attributes.route = "..."`). The encoded form has no character that
 * needs escaping inside a filter string, which the raw name would. The raw names travel as the
 * `namespace` and `queue` attributes for humans reading a dead-letter message.
 */
const PREFIX = 'qcloud';
export const MAX_RESOURCE_ID_LENGTH = 255;

const SAFE = /^[A-Za-z0-9-]$/;
const HEX_BYTE = /^[0-9a-f]{2}$/;

export function encodeName(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += byte < 0x80 && SAFE.test(char) ? char : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return encoded;
}

export function decodeName(encoded: string): string | null {
  const bytes: number[] = [];
  for (let at = 0; at < encoded.length; at += 1) {
    const char = encoded.charAt(at);
    if (SAFE.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else if (char === '_' && HEX_BYTE.test(encoded.slice(at + 1, at + 3))) {
      bytes.push(Number.parseInt(encoded.slice(at + 1, at + 3), 16));
      at += 2;
    } else {
      return null;
    }
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    // Only the canonical spelling decodes: `_41` for `A`, or uppercase hex, was not made by encodeName.
    return encodeName(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export interface EnvironmentNames {
  readonly topic: string;
  readonly deadLetterTopic: string;
}

export interface QueueNames {
  /** The value of the `route` attribute every bell for this queue carries. */
  readonly route: string;
  readonly subscription: string;
  readonly deadLetterSubscription: string;
  /** The subscription filter, on both the queue's subscription and its dead-letter subscription. */
  readonly filter: string;
}

function checked(id: string, what: string): string {
  if (id.length > MAX_RESOURCE_ID_LENGTH) {
    throw new TransportError(
      `${what} would be ${id.length} characters; a Pub/Sub resource id holds at most ${MAX_RESOURCE_ID_LENGTH}`
    );
  }
  return id;
}

function requireName(value: string, what: string): void {
  if (value.length === 0) throw new TransportError(`${what} must not be empty`);
}

export function environmentNames(namespace: string): EnvironmentNames {
  requireName(namespace, 'a namespace');
  const base = `${PREFIX}.${encodeName(namespace)}`;
  return {
    topic: checked(`${base}.bells`, 'the topic name'),
    deadLetterTopic: checked(`${base}.bells-dlq`, 'the dead-letter topic name'),
  };
}

/** Throws `TransportError` when the pair cannot be a resource id. */
export function queueNames(namespace: string, queue: string): QueueNames {
  requireName(namespace, 'a namespace');
  requireName(queue, 'a queue name');
  const environment = `${PREFIX}.${encodeName(namespace)}`;
  const encodedQueue = encodeName(queue);
  const route = `${encodeName(namespace)}.${encodedQueue}`;
  return {
    route,
    subscription: checked(
      `${environment}.sub.${encodedQueue}`,
      `the subscription name of "${queue}"`
    ),
    deadLetterSubscription: checked(
      `${environment}.dlq.${encodedQueue}`,
      `the dead-letter subscription name of "${queue}"`
    ),
    filter: `attributes.route = "${route}"`,
  };
}

/** The queue a subscription id or dead-letter subscription id belongs to, for the panel; null if it is not ours. */
export function queueOfSubscription(
  id: string
): { namespace: string; queue: string; deadLetter: boolean } | null {
  const [prefix, namespace, kind, queue, ...rest] = id.split('.');
  if (prefix !== PREFIX || rest.length > 0 || (kind !== 'sub' && kind !== 'dlq')) return null;
  const decodedNamespace = namespace === undefined ? null : decodeName(namespace);
  const decodedQueue = queue === undefined ? null : decodeName(queue);
  if (!decodedNamespace || !decodedQueue) return null;
  return { namespace: decodedNamespace, queue: decodedQueue, deadLetter: kind === 'dlq' };
}
