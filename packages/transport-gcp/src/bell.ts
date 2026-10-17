import type { Bell } from '@qelay-cloud/core';
import { queueNames } from './names';

/** A bell as Pub/Sub carries it: the JSON body, and the attributes the subscription filters on. */
export interface WireBell {
  readonly data: Buffer;
  readonly attributes: Record<string, string>;
}

/** Throws `TransportError` for a bell whose queue cannot be a subscription name. */
export function encodeBell(bell: Bell): WireBell {
  const { route } = queueNames(bell.namespace, bell.queue);
  const body: Bell =
    bell.jobId === undefined ? { namespace: bell.namespace, queue: bell.queue } : bell;
  return {
    data: Buffer.from(JSON.stringify(body), 'utf8'),
    attributes: { route, namespace: bell.namespace, queue: bell.queue },
  };
}

/**
 * The bell in a message body, or null when the body is not one. A bell for another queue or
 * namespace than the subscription's is not one either: the filter should have kept it away, and
 * a subscriber must never act on it.
 */
export function decodeBell(
  data: Buffer | Uint8Array,
  expected: { readonly namespace: string; readonly queue: string }
): Bell | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { namespace, queue, jobId } = value as Record<string, unknown>;
  if (namespace !== expected.namespace || queue !== expected.queue) return null;
  if (jobId !== undefined && typeof jobId !== 'string') return null;
  return jobId === undefined ? { namespace, queue } : { namespace, queue, jobId };
}
