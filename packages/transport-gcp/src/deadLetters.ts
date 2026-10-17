import type { DeadLetter } from '@qelay-cloud/core';
import { decodeBell } from './bell';

/** One message pulled from a dead-letter subscription, as the Pub/Sub API returns it. */
export interface PulledMessage {
  readonly ackId: string;
  readonly data: Uint8Array | string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Epoch milliseconds the message was published to the dead-letter topic, if known. */
  readonly publishTime: number | null;
}

/**
 * What a peek needs of the Pub/Sub API: a synchronous pull and a way to give messages back. The
 * transport builds the real one from the client library; a test passes a stub.
 */
export interface DeadLetterSource {
  /** Pulls up to `maxMessages` without acknowledging them. Resolves empty when there are none. */
  pull(subscription: string, maxMessages: number): Promise<PulledMessage[]>;
  /** Makes the messages deliverable again now (an ack deadline of 0), instead of after the deadline. */
  release(subscription: string, ackIds: readonly string[]): Promise<void>;
}

/** The attribute Pub/Sub sets on a dead-lettered message: how often it was delivered before. */
export const DELIVERY_COUNT_ATTRIBUTE = 'CloudPubSubDeadLetterSourceDeliveryCount';

/** The largest peek: a page of the panel, not a way to read a backlog. */
export const MAX_PEEK = 100;

/**
 * Reads the dead-lettered bells of one queue without consuming them. Every pulled message is given
 * back at once, also when decoding fails, so the peek never holds a bell away from a redrive.
 * Message bodies are decoded as bells only: a body that is not one comes back with `bell: null`
 * and nothing of its content.
 */
export async function peekDeadLetters(
  source: DeadLetterSource,
  subscription: string,
  route: { readonly namespace: string; readonly queue: string },
  limit: number
): Promise<DeadLetter[]> {
  const count = Math.max(0, Math.min(MAX_PEEK, Math.floor(limit)));
  if (count === 0) return [];
  const pulled = await source.pull(subscription, count);
  try {
    return pulled.map((message) => {
      const body =
        typeof message.data === 'string' ? Buffer.from(message.data, 'utf8') : message.data;
      const delivered = Number(message.attributes[DELIVERY_COUNT_ATTRIBUTE]);
      return {
        bell: decodeBell(body, route),
        deliveryCount: Number.isInteger(delivered) && delivered > 0 ? delivered : null,
        deadLetteredAt: message.publishTime,
      };
    });
  } finally {
    if (pulled.length > 0) {
      await source
        .release(
          subscription,
          pulled.map((message) => message.ackId)
        )
        // The ack deadline returns the messages anyway; a failed release is not a failed peek.
        .catch(() => undefined);
    }
  }
}

interface SubscriberStub {
  pull(
    request: { subscription: string; maxMessages: number },
    options?: { timeout?: number }
  ): Promise<
    [
      {
        receivedMessages?: Array<{
          ackId?: string | null;
          message?: {
            data?: Uint8Array | string | null;
            attributes?: Record<string, string> | null;
            publishTime?: { seconds?: number | string | null; nanos?: number | null } | null;
          } | null;
        }> | null;
      },
      ...unknown[],
    ]
  >;
  modifyAckDeadline(request: {
    subscription: string;
    ackIds: string[];
    ackDeadlineSeconds: number;
  }): Promise<unknown>;
}

/** The source over the library's v1 subscriber client. `timeoutMs` bounds one pull. */
export function subscriberSource(client: SubscriberStub, timeoutMs: number): DeadLetterSource {
  return {
    async pull(subscription, maxMessages) {
      const [response] = await client.pull({ subscription, maxMessages }, { timeout: timeoutMs });
      const messages: PulledMessage[] = [];
      for (const received of response.receivedMessages ?? []) {
        if (!received.ackId) continue;
        const published = received.message?.publishTime;
        messages.push({
          ackId: received.ackId,
          data: received.message?.data ?? '',
          attributes: received.message?.attributes ?? {},
          publishTime:
            published?.seconds === undefined || published.seconds === null
              ? null
              : Number(published.seconds) * 1_000 + Math.floor((published.nanos ?? 0) / 1e6),
        });
      }
      return messages;
    },
    async release(subscription, ackIds) {
      if (ackIds.length === 0) return;
      await client.modifyAckDeadline({
        subscription,
        ackIds: [...ackIds],
        ackDeadlineSeconds: 0,
      });
    },
  };
}

export type { SubscriberStub };
