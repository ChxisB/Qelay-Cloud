import type { PubSub } from '@google-cloud/pubsub';
import { environmentNames, queueNames } from './names';

/**
 * Creates and removes the Pub/Sub resources the transport expects, for an emulator, a test, or a
 * developer's own project. Production infrastructure is Terraform's (task 21), which must produce
 * the same names (`names.ts`) and the same settings: the transport never creates a resource itself,
 * so a missing one is an error a worker reports, not a surprise bill.
 *
 * Calling these against Google Cloud creates real, billable resources: that needs the owner's say-so.
 * On a real project the Pub/Sub service account also needs the publisher role on the dead-letter
 * topic and the subscriber role on each subscription for dead-lettering to work; the emulator checks
 * neither.
 */
export interface TopologyOptions {
  /** Ack deadline in seconds, 10 to 600. The client extends it while a bell is held, so this is only the floor. Default 30. */
  readonly ackDeadlineSeconds?: number;
  /** Deliveries before a bell moves to the dead-letter topic, 5 to 100. Default 5. */
  readonly maxDeliveryAttempts?: number;
  /** Redelivery backoff after a nack or an expired deadline, in seconds, 0 to 600. Default 1 and 10. */
  readonly minimumBackoffSeconds?: number;
  readonly maximumBackoffSeconds?: number;
}

const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;

function codeOf(error: unknown): number | undefined {
  return (error as { code?: number } | null)?.code;
}

async function ignoring(code: number, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (codeOf(error) !== code) throw error;
  }
}

/** The environment's two topics. Safe to repeat. */
export async function ensureEnvironment(pubsub: PubSub, namespace: string): Promise<void> {
  const { topic, deadLetterTopic } = environmentNames(namespace);
  await ignoring(ALREADY_EXISTS, () => pubsub.createTopic(deadLetterTopic));
  await ignoring(ALREADY_EXISTS, () => pubsub.createTopic(topic));
}

/**
 * One queue's subscription and its dead-letter subscription, both filtered to the queue's bells.
 * Needs `ensureEnvironment` first. Safe to repeat; it does not change a subscription that exists.
 */
export async function ensureQueue(
  pubsub: PubSub,
  namespace: string,
  queue: string,
  options: TopologyOptions = {}
): Promise<void> {
  const environment = environmentNames(namespace);
  const names = queueNames(namespace, queue);
  const deadLetterTopic = pubsub.topic(environment.deadLetterTopic);
  await ignoring(ALREADY_EXISTS, () =>
    deadLetterTopic.createSubscription(names.deadLetterSubscription, { filter: names.filter })
  );
  await ignoring(ALREADY_EXISTS, () =>
    pubsub.topic(environment.topic).createSubscription(names.subscription, {
      filter: names.filter,
      ackDeadlineSeconds: options.ackDeadlineSeconds ?? 30,
      // No ordering key and no exactly-once delivery: Postgres orders and fences, the bell only wakes.
      deadLetterPolicy: {
        deadLetterTopic: deadLetterTopic.name,
        maxDeliveryAttempts: options.maxDeliveryAttempts ?? 5,
      },
      retryPolicy: {
        minimumBackoff: { seconds: options.minimumBackoffSeconds ?? 1 },
        maximumBackoff: { seconds: options.maximumBackoffSeconds ?? 10 },
      },
    })
  );
}

/** Deletes what `ensureQueue` made. A resource that is already gone is not an error. */
export async function removeQueue(pubsub: PubSub, namespace: string, queue: string): Promise<void> {
  const names = queueNames(namespace, queue);
  for (const id of [names.subscription, names.deadLetterSubscription]) {
    await ignoring(NOT_FOUND, () => pubsub.subscription(id).delete());
  }
}

/** Deletes what `ensureEnvironment` made. Remove the queues first. */
export async function removeEnvironment(pubsub: PubSub, namespace: string): Promise<void> {
  const { topic, deadLetterTopic } = environmentNames(namespace);
  for (const id of [topic, deadLetterTopic]) {
    await ignoring(NOT_FOUND, () => pubsub.topic(id).delete());
  }
}
