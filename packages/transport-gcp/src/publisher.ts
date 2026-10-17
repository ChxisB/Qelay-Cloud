import type { PublishOptions, Topic } from '@google-cloud/pubsub';
import type { RingItem, RingResult } from '@qelay-cloud/core';
import { encodeBell } from './bell';

/** Pub/Sub's limit on messages in one publish request. */
export const MAX_RING_BATCH = 1_000;

/** gRPC status codes the client may retry: CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE. */
const RETRYABLE = [1, 2, 4, 8, 10, 13, 14];
const INVALID_ARGUMENT = 3;

/**
 * Publish settings for a topic whose `ring` must answer within `budgetMs`. The client batches what
 * one `ring` publishes into one request (up to `MAX_RING_BATCH`), retries transient failures with
 * backoff inside the budget, and fails every message of a batch it gave up on.
 */
export function publishSettings(budgetMs: number): PublishOptions {
  const rpc = Math.max(1, Math.min(budgetMs, 5_000));
  return {
    batching: { maxMessages: MAX_RING_BATCH, maxMilliseconds: 1 },
    gaxOpts: {
      retry: {
        retryCodes: RETRYABLE,
        backoffSettings: {
          initialRetryDelayMillis: 100,
          retryDelayMultiplier: 1.5,
          maxRetryDelayMillis: 1_000,
          initialRpcTimeoutMillis: rpc,
          rpcTimeoutMultiplier: 1,
          maxRpcTimeoutMillis: rpc,
          totalTimeoutMillis: Math.max(1, budgetMs),
        },
      },
    },
  };
}

/**
 * Publishes one message per item and returns one result per item, in order. A failure becomes a
 * result, never a throw: the caller reports only the bells that were taken, and the tick rings the
 * rest. `onError` gets the first error of the call.
 */
export async function publishBells(
  topic: Pick<Topic, 'publishMessage'>,
  namespace: string,
  items: readonly RingItem[],
  onError: (error: unknown) => void
): Promise<RingResult[]> {
  const results: RingResult[] = items.map(() => ({ ok: false, reason: 'unreachable' }));
  const publishing: Promise<void>[] = [];
  let firstError: unknown;
  items.forEach((item, index) => {
    const delay = Math.ceil(item.deliverAfterMs ?? 0);
    // Pub/Sub has no per-message delay: a bell that must wait is the tick's to ring when it is due.
    if (Number.isNaN(delay) || !Number.isFinite(delay) || item.bell.namespace !== namespace) {
      results[index] = { ok: false, reason: 'rejected' };
      return;
    }
    if (delay > 0) {
      results[index] = { ok: false, reason: 'delay-too-long' };
      return;
    }
    try {
      const { data, attributes } = encodeBell(item.bell);
      publishing.push(
        topic.publishMessage({ data, attributes }).then(
          () => {
            results[index] = { ok: true };
          },
          (error: unknown) => {
            firstError ??= error;
            const code = (error as { code?: number } | null)?.code;
            results[index] = {
              ok: false,
              reason: code === INVALID_ARGUMENT ? 'rejected' : 'unreachable',
            };
          }
        )
      );
    } catch (error) {
      // A name that cannot be a subscription id: no subscriber could ever receive this bell.
      results[index] = { ok: false, reason: 'rejected' };
      firstError ??= error;
    }
  });
  await Promise.all(publishing);
  if (firstError !== undefined) onError(firstError);
  return results;
}
