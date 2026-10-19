import { describe } from 'bun:test';
import { PubSub } from '@google-cloud/pubsub';
import { uniqueNamespace, waitFor } from '../../../test/support/doorbell/util';
import type { TopologyOptions } from '../src';
import {
  ensureEnvironment,
  ensureQueue,
  GRPC_ONLY,
  queueNames,
  removeEnvironment,
  removeQueue,
} from '../src';

/**
 * Pub/Sub emulator access for the transport's tests. The client is always pointed at the emulator,
 * never at Google Cloud: `QCLOUD_PUBSUB_EMULATOR_HOST` (default 127.0.0.1:58085) is the only
 * endpoint it accepts. Suites skip with a warning when the emulator is down, unless
 * `QCLOUD_REQUIRE_PUBSUB=1`, in which case they fail.
 */
export const EMULATOR_PROJECT = 'qcloud-test';
const DEFAULT_EMULATOR_HOST = '127.0.0.1:58085';

export function emulatorHost(): string {
  return process.env.QCLOUD_PUBSUB_EMULATOR_HOST ?? DEFAULT_EMULATOR_HOST;
}

/** A client on the emulator, or on `host` (a `host:port` of a loopback proxy in front of it). */
export function emulatorClient(host: string = emulatorHost()): PubSub {
  return new PubSub({
    projectId: EMULATOR_PROJECT,
    apiEndpoint: host,
    emulatorMode: true,
    ...GRPC_ONLY,
  });
}

export async function isEmulatorReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${emulatorHost()}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const requirePubsub = process.env.QCLOUD_REQUIRE_PUBSUB === '1';
const reachable = requirePubsub || (await isEmulatorReachable());

if (!reachable) {
  console.warn(
    `[transport-gcp] Pub/Sub emulator not reachable at ${emulatorHost()}: its suites are skipped. ` +
      'Start it with `gcloud beta emulators pubsub start --host-port=127.0.0.1:58085 --project=qcloud-test`, ' +
      'or set QCLOUD_REQUIRE_PUBSUB=1 to fail instead of skip.'
  );
}

/** `describe` for suites that need the emulator. Combine with the database guard where a store is used. */
export const describePubsub: typeof describe = reachable ? describe : describe.skip;

export interface PulledMessage {
  readonly ackId: string;
  readonly deliveryAttempt?: number;
  readonly message: {
    readonly data: string;
    readonly messageId: string;
    readonly attributes?: Record<string, string>;
  };
}

/** Synchronous pull without waiting: what is deliverable right now. Nothing is acked. */
export async function pullNow(subscriptionId: string, max = 100): Promise<PulledMessage[]> {
  const response = await fetch(
    `http://${emulatorHost()}/v1/projects/${EMULATOR_PROJECT}/subscriptions/${subscriptionId}:pull`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxMessages: max, returnImmediately: true }),
    }
  );
  if (!response.ok)
    throw new Error(`pull ${subscriptionId}: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { receivedMessages?: PulledMessage[] };
  return body.receivedMessages ?? [];
}

export interface Environment {
  readonly namespace: string;
  readonly pubsub: PubSub;
  /** The subscription ids of a queue, for reading what dead-lettered. */
  names(queue: string): ReturnType<typeof queueNames>;
  /** Deletes every resource and closes the client. Safe to call more than once. */
  destroy(): Promise<void>;
}

export interface EnvironmentOptions extends Omit<TopologyOptions, 'hot'> {
  readonly queues: readonly string[];
  /** The queues (a subset of `queues`) that get their own topic. */
  readonly hotQueues?: readonly string[];
  /** Defaults to a fresh unique namespace, so test files never share messages. */
  readonly namespace?: string;
}

/** Short redelivery timings, so a test that waits for a redelivery waits seconds, not a minute. */
export const FAST_TOPOLOGY: TopologyOptions = {
  ackDeadlineSeconds: 10,
  maxDeliveryAttempts: 5,
  minimumBackoffSeconds: 0,
  maximumBackoffSeconds: 1,
};

export async function openEnvironment(options: EnvironmentOptions): Promise<Environment> {
  const pubsub = emulatorClient();
  const namespace = options.namespace ?? uniqueNamespace();
  const topology = { ...FAST_TOPOLOGY, ...options };
  await ensureEnvironment(pubsub, namespace);
  const hot = new Set(options.hotQueues ?? []);
  for (const queue of options.queues) {
    await ensureQueue(pubsub, namespace, queue, { ...topology, hot: hot.has(queue) });
  }
  let destroyed = false;
  return {
    namespace,
    pubsub,
    names: (queue) => queueNames(namespace, queue, hot.has(queue)),
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const queue of options.queues)
        await removeQueue(pubsub, namespace, queue).catch(() => {});
      await removeEnvironment(pubsub, namespace).catch(() => {});
      await pubsub.close().catch(() => {});
    },
  };
}

export { uniqueNamespace, waitFor };
