import { describe } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { uniqueNamespace, waitFor } from '../../../test/support/doorbell/util';
import type { ProvisionedQueue, QueueSettings, SqsTransportOptions } from '../src';
import { ensureQueue, queueNames, removeQueue, SqsTransport } from '../src';

export { uniqueNamespace, waitFor };

/**
 * SQS emulator access for the transport's tests. The client only talks to a loopback endpoint
 * (ElasticMQ, default http://127.0.0.1:59324) and uses fixed dummy credentials, so it can never reach
 * AWS or use the developer's AWS profile. Suites skip with a warning when the emulator is down,
 * unless `QCLOUD_REQUIRE_SQS=1`, in which case they fail.
 *
 * Every result from these suites is an "emulator" result: ElasticMQ is not SQS (see docs/limits.md).
 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:59324';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const EMULATOR_REGION = 'us-east-1';
const EMULATOR_CREDENTIALS = { accessKeyId: 'qcloud-test', secretAccessKey: 'qcloud-test' };

export function sqsEndpoint(): string {
  const endpoint = process.env.QCLOUD_SQS_ENDPOINT ?? DEFAULT_ENDPOINT;
  const { hostname } = new URL(endpoint);
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(`[${hostname}]`)) {
    throw new Error(`The SQS transport tests only talk to a loopback emulator, not ${hostname}`);
  }
  return endpoint;
}

export function emulatorClient(): SQSClient {
  return new SQSClient({
    endpoint: sqsEndpoint(),
    region: EMULATOR_REGION,
    credentials: EMULATOR_CREDENTIALS,
    maxAttempts: 1,
  });
}

export async function isEmulatorReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${sqsEndpoint()}/?Action=ListQueues`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const requireSqs = process.env.QCLOUD_REQUIRE_SQS === '1';
const reachable = requireSqs || (await isEmulatorReachable());

if (!reachable) {
  console.warn(
    `[transport-aws] SQS emulator not reachable at ${sqsEndpoint()}: its suites are skipped. ` +
      'Start it with `docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs`, ' +
      'or set QCLOUD_REQUIRE_SQS=1 to fail instead of skip.'
  );
}

/** `describe` for suites that need the emulator. Combine with the database guard where a store is used. */
export const describeSqs: typeof describe = reachable ? describe : describe.skip;

/** Short timings, so a test that waits for a redelivery waits seconds, not half a minute. */
export const FAST_QUEUE: QueueSettings = { visibilityTimeoutSeconds: 3, maxReceiveCount: 5 };
/** What a transport built by `transportFor` sends with each receive: the same 3 s. */
export const FAST_VISIBILITY_SECONDS = 3;

export interface Environment {
  readonly namespace: string;
  readonly client: SQSClient;
  /** The queue and dead-letter queue URLs of a queue, for reading what dead-lettered. */
  provisioned(queue: string): ProvisionedQueue;
  /** Deletes every queue and closes the client. Safe to call more than once. */
  destroy(): Promise<void>;
}

export interface EnvironmentOptions extends QueueSettings {
  readonly queues: readonly string[];
  /** Defaults to a fresh unique namespace, so test files never share messages. */
  readonly namespace?: string;
}

export async function openEnvironment(options: EnvironmentOptions): Promise<Environment> {
  const client = emulatorClient();
  const namespace = options.namespace ?? uniqueNamespace();
  const settings = { ...FAST_QUEUE, ...options };
  const made = new Map<string, ProvisionedQueue>();
  for (const queue of options.queues) {
    made.set(queue, await ensureQueue(client, namespace, queue, settings));
  }
  let destroyed = false;
  return {
    namespace,
    client,
    provisioned(queue) {
      const found = made.get(queue);
      if (!found) throw new Error(`queue ${queue} was not part of this environment`);
      return found;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const queue of options.queues) {
        await removeQueue(client, namespace, queue).catch(() => {});
      }
      client.destroy();
    },
  };
}

/** A transport on the emulator with its own client, as a separate process would have. */
export function transportFor(
  namespace: string,
  options: Partial<SqsTransportOptions> = {}
): SqsTransport {
  return new SqsTransport({
    namespace,
    region: EMULATOR_REGION,
    endpoint: sqsEndpoint(),
    credentials: EMULATOR_CREDENTIALS,
    visibilityTimeoutSeconds: FAST_VISIBILITY_SECONDS,
    onError: (error, source) => console.error(`[transport] ${source}: ${error.message}`),
    ...options,
  });
}

/** What is receivable right now, without waiting. The messages are left in flight, not deleted. */
export async function receiveNow(
  client: SQSClient,
  queueUrl: string,
  max = 10,
  visibilityTimeout = 0
): Promise<Message[]> {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 0,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
  );
  return Messages ?? [];
}

/** Bells in a queue's dead-letter queue (peeked with a 0 s visibility timeout, so they stay). */
export async function deadLetterCount(env: Environment, queue: string): Promise<number> {
  const url = env.provisioned(queue).deadLetterUrl;
  const seen = new Set<string>();
  for (let round = 0; round < 3; round++) {
    for (const message of await receiveNow(env.client, url)) seen.add(message.MessageId ?? '');
  }
  return seen.size;
}

export interface Rig {
  readonly env: Environment;
  readonly transport: SqsTransport;
  /** Errors the transport handled, as `source: message`. */
  readonly errors: string[];
}

/**
 * An environment with one queue (`q` unless `queues` says otherwise) and a transport on it, torn
 * down after `body`. Nothing is shared between calls: each gets its own namespace.
 */
export async function withTransport<T>(
  body: (rig: Rig) => Promise<T>,
  options: {
    queues?: readonly string[];
    queue?: QueueSettings;
    transport?: Partial<SqsTransportOptions>;
  } = {}
): Promise<T> {
  const env = await openEnvironment({ queues: options.queues ?? ['q'], ...options.queue });
  const errors: string[] = [];
  const transport = transportFor(env.namespace, {
    onError: (error, source) => errors.push(`${source}: ${error.message}`),
    ...options.transport,
  });
  try {
    return await body({ env, transport, errors });
  } finally {
    await transport.close();
    await env.destroy();
  }
}

export { queueNames };
