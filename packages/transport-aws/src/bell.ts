import type { Bell } from '@qelay-cloud/core';

/** SQS: a message body, and the whole of one `SendMessageBatch`, is at most 256 KiB by default. */
export const MAX_MESSAGE_BYTES = 262_144;

/**
 * The message body of a bell: its JSON. The queue is the route (one SQS queue per Qelay queue), so
 * there are no message attributes to filter on and none to pay for.
 */
export function encodeBell(bell: Bell): string {
  const body: Bell =
    bell.jobId === undefined ? { namespace: bell.namespace, queue: bell.queue } : bell;
  return JSON.stringify(body);
}

/**
 * The bell in a message body, or null when the body is not one. A bell for another queue or
 * namespace than the subscriber's is not one either: separate SQS queues should have kept it away,
 * and a subscriber must never act on it.
 */
export function decodeBell(
  body: string | undefined,
  expected: { readonly namespace: string; readonly queue: string }
): Bell | null {
  if (body === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { namespace, queue, jobId } = value as Record<string, unknown>;
  if (namespace !== expected.namespace || queue !== expected.queue) return null;
  if (jobId !== undefined && typeof jobId !== 'string') return null;
  return jobId === undefined ? { namespace, queue } : { namespace, queue, jobId };
}
