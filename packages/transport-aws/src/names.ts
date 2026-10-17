import { createHash } from 'node:crypto';
import { TransportError } from '@qelay-cloud/core';

/**
 * Resource naming. A Qelay queue name is any non-empty string; an SQS queue name is 1 to 80
 * characters of `[A-Za-z0-9_-]`. So a name is encoded, and one that does not fit is hashed:
 *
 * - `encodeName` keeps `[A-Za-z0-9-]` and writes every other UTF-8 byte as `_` plus two lowercase
 *   hex digits. An underscore is therefore always followed by two hex digits, and `__` cannot occur
 *   inside an encoded name, so `__` separates the parts of a resource name without ambiguity.
 * - `decodeName` is its inverse, and answers null for anything `encodeName` could not have made.
 *
 * ```
 * queue         qcloud-<namespace>__<queue>
 * dead letters  qcloud-<namespace>__<queue>__dlq
 * ```
 *
 * A pair whose dead-letter name would pass 80 characters is hashed, both names of it:
 *
 * ```
 * queue         qcloud-h-<slug>-<20 hex digits of sha256>
 * dead letters  qcloud-h-<slug>-<20 hex digits of sha256>-dlq
 * ```
 *
 * The slug is the letters, digits and hyphens of `<namespace>-<queue>`, cut short, only so a person
 * can find the queue in a console. A hashed name never contains `__`, so it cannot equal a plain
 * one. The hash does not reverse: `queueNames` reproduces it, and the queue carries the
 * `qelay:namespace` and `qelay:queue` tags (`ensureQueue` sets them; Terraform must too) for anyone
 * working backwards from a console.
 *
 * One dead-letter queue per Qelay queue, so `stats(queue)` and `peekDeadLetters(queue)` read the
 * dead letters of that queue and no other.
 */
const PREFIX = 'qcloud-';
const HASHED_PREFIX = 'qcloud-h-';
const DEAD_LETTER_SUFFIX = '__dlq';
const HASHED_DEAD_LETTER_SUFFIX = '-dlq';
const HASH_LENGTH = 20;
const MAX_SLUG_LENGTH = 40;
/** SQS: a queue name is at most 80 characters. */
export const MAX_QUEUE_NAME_LENGTH = 80;

export const NAMESPACE_TAG = 'qelay:namespace';
export const QUEUE_TAG = 'qelay:queue';

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

export interface QueueNames {
  /** The standard queue the bells of this Qelay queue are rung into. */
  readonly queue: string;
  /** Where the broker moves a bell it gave up on. A metric, never replayed. */
  readonly deadLetter: string;
  /** True when the names are the hash form, which cannot be read back from the name alone. */
  readonly hashed: boolean;
  /** The tags both queues carry, so the mapping can be found from the console. */
  readonly tags: Readonly<Record<string, string>>;
}

/** Throws `TransportError` for a namespace that is empty: a configuration mistake. */
export function requireNamespace(namespace: string): void {
  if (namespace.length === 0) throw new TransportError('a namespace must not be empty');
}

/** Throws `TransportError` when either part is empty. Any other pair has a name: it is hashed if long. */
export function queueNames(namespace: string, queue: string): QueueNames {
  requireNamespace(namespace);
  if (queue.length === 0) throw new TransportError('a queue name must not be empty');
  const tags = { [NAMESPACE_TAG]: namespace, [QUEUE_TAG]: queue };
  const plain = `${PREFIX}${encodeName(namespace)}__${encodeName(queue)}`;
  if (plain.length + DEAD_LETTER_SUFFIX.length <= MAX_QUEUE_NAME_LENGTH) {
    return { queue: plain, deadLetter: `${plain}${DEAD_LETTER_SUFFIX}`, hashed: false, tags };
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([namespace, queue]))
    .digest('hex')
    .slice(0, HASH_LENGTH);
  const slug = `${namespace}-${queue}`
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  const hashed = `${HASHED_PREFIX}${slug === '' ? '' : `${slug}-`}${digest}`;
  return {
    queue: hashed,
    deadLetter: `${hashed}${HASHED_DEAD_LETTER_SUFFIX}`,
    hashed: true,
    tags,
  };
}

/**
 * The queue a plain queue or dead-letter queue name belongs to, for tools that list queues. Null
 * when the name is not ours or is the hash form (read its tags instead).
 */
export function queueOfName(
  name: string
): { namespace: string; queue: string; deadLetter: boolean } | null {
  if (!name.startsWith(PREFIX) || name.startsWith(HASHED_PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0) return null;
  let queue = rest.slice(split + 2);
  let deadLetter = false;
  if (queue.endsWith(DEAD_LETTER_SUFFIX)) {
    queue = queue.slice(0, -DEAD_LETTER_SUFFIX.length);
    deadLetter = true;
  }
  const decodedNamespace = decodeName(rest.slice(0, split));
  const decodedQueue = decodeName(queue);
  if (!decodedNamespace || !decodedQueue) return null;
  return { namespace: decodedNamespace, queue: decodedQueue, deadLetter };
}
