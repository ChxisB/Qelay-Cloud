import type { SQSClient } from '@aws-sdk/client-sqs';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { DeadLetter } from '@qelay-cloud/core';
import { decodeBell } from './bell';
import { MAX_RECEIVE } from './receiver';

/** The largest peek: a page of the panel, not a way to read a backlog. */
export const MAX_PEEK = 100;
/** A peek on SQS samples, so it asks again a few times; it stops at the first round that finds nothing new. */
const MAX_ROUNDS = 8;

/**
 * Reads the dead-lettered bells of one queue without consuming them. Each is received with a
 * visibility timeout of 0, so it is visible to the next reader (or the next round) at once and is
 * never deleted. Message bodies are decoded as bells only: a body that is not one comes back with
 * `bell: null` and nothing of its content.
 *
 * SQS has no "browse": a receive returns up to 10 of the messages it picks, so a queue holding more
 * than 10 is sampled over a few rounds and the result can miss some. SQS does not tell the bell's
 * delivery count in the dead-letter queue or when it was moved there, so both are null.
 */
export async function peekDeadLetters(
  client: SQSClient,
  deadLetterUrl: string,
  route: { readonly namespace: string; readonly queue: string },
  limit: number
): Promise<DeadLetter[]> {
  const count = Math.max(0, Math.min(MAX_PEEK, Math.floor(limit)));
  if (count === 0) return [];
  const seen = new Map<string, DeadLetter>();
  for (let round = 0; round < MAX_ROUNDS && seen.size < count; round += 1) {
    const out = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetterUrl,
        MaxNumberOfMessages: Math.min(MAX_RECEIVE, count - seen.size),
        // A long poll asks every server: a short poll samples some and can answer empty for a full queue.
        WaitTimeSeconds: round === 0 ? 1 : 0,
        VisibilityTimeout: 0,
      })
    );
    const before = seen.size;
    for (const message of out.Messages ?? []) {
      const id = message.MessageId ?? message.ReceiptHandle;
      if (id === undefined || seen.has(id)) continue;
      seen.set(id, {
        bell: decodeBell(message.Body, route),
        deliveryCount: null,
        deadLetteredAt: null,
      });
    }
    if (seen.size === before) break;
  }
  return [...seen.values()].slice(0, count);
}
