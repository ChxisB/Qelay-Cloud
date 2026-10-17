import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import { queueNames } from './names';

/**
 * Creating queues, for an emulator or a test. The transport never creates a queue: in a real
 * environment they come from Terraform (task 42), which must produce the same names, tags and
 * settings. `ensureQueue` is the reference for those settings.
 */
export interface QueueSettings {
  /** The queue's own visibility timeout. The transport sends its own with every receive. Default 30. */
  readonly visibilityTimeoutSeconds?: number;
  /**
   * Receives before SQS moves a bell to the dead-letter queue. Size it with the retry backoff: with a
   * backoff doubling from 1 s to 30 s, 5 dead-letters a bell after about 30 s of database outage and
   * 10 after about 3 minutes. A dead-lettered bell is harmless (the tick rings it again) but is a
   * metric. Default 5.
   */
  readonly maxReceiveCount?: number;
  /** Retention of the queue. Default 4 days (SQS's own default). */
  readonly retentionSeconds?: number;
  /** Retention of the dead-letter queue. SQS counts it from the bell's first enqueue. Default 14 days, the maximum. */
  readonly deadLetterRetentionSeconds?: number;
}

export const FOURTEEN_DAYS_SECONDS = 1_209_600;

export interface ProvisionedQueue {
  readonly queueUrl: string;
  readonly deadLetterUrl: string;
  readonly queueArn: string;
}

/** Creates the dead-letter queue and the queue with its redrive policy, or finds them. */
export async function ensureQueue(
  client: SQSClient,
  namespace: string,
  queue: string,
  settings: QueueSettings = {}
): Promise<ProvisionedQueue> {
  const names = queueNames(namespace, queue);
  const dead = await client.send(
    new CreateQueueCommand({
      QueueName: names.deadLetter,
      Attributes: {
        MessageRetentionPeriod: String(
          settings.deadLetterRetentionSeconds ?? FOURTEEN_DAYS_SECONDS
        ),
      },
    })
  );
  const deadLetterUrl = required(dead.QueueUrl, names.deadLetter);
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: names.queue,
      Attributes: {
        VisibilityTimeout: String(settings.visibilityTimeoutSeconds ?? 30),
        ...(settings.retentionSeconds === undefined
          ? {}
          : { MessageRetentionPeriod: String(settings.retentionSeconds) }),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: await arnOf(client, deadLetterUrl),
          maxReceiveCount: settings.maxReceiveCount ?? 5,
        }),
      },
    })
  );
  const queueUrl = required(main.QueueUrl, names.queue);
  // Tags carry the mapping back from a hashed name. An emulator that lacks tagging must not stop a test.
  for (const url of [queueUrl, deadLetterUrl]) {
    await client
      .send(new TagQueueCommand({ QueueUrl: url, Tags: { ...names.tags } }))
      .catch(() => {});
  }
  return { queueUrl, deadLetterUrl, queueArn: await arnOf(client, queueUrl) };
}

/** Deletes a queue and its dead-letter queue. A queue that is not there is not an error. */
export async function removeQueue(
  client: SQSClient,
  namespace: string,
  queue: string
): Promise<void> {
  const names = queueNames(namespace, queue);
  for (const name of [names.queue, names.deadLetter]) {
    try {
      const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
      if (QueueUrl) await client.send(new DeleteQueueCommand({ QueueUrl }));
    } catch {
      // Already gone.
    }
  }
}

async function arnOf(client: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })
  );
  return required(Attributes?.QueueArn, queueUrl);
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`SQS returned no value for ${what}`);
  return value;
}
