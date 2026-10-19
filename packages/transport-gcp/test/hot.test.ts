import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { ensureQueue, PubSubTransport, queueNames, removeQueue } from '../src';
import type { Environment } from './support';
import { describePubsub, openEnvironment, pullNow, waitFor } from './support';

let env: Environment;
let transport: PubSubTransport;

describePubsub('a hot queue has its own topic', () => {
  beforeEach(async () => {
    env = await openEnvironment({ queues: ['hot', 'cold'], hotQueues: ['hot'] });
    transport = new PubSubTransport({
      namespace: env.namespace,
      client: env.pubsub,
      hotQueues: ['hot'],
    });
  });
  afterEach(async () => {
    await transport.close();
    await env.destroy();
  });

  test('each queue gets its own bells, and the hot one is delivered end to end', async () => {
    const bell = (queue: string, jobId: string) => ({
      bell: { namespace: env.namespace, queue, jobId },
    });
    expect(
      await transport.ring([bell('hot', 'h1'), bell('cold', 'c1'), bell('hot', 'h2')])
    ).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    const jobs = async (queue: string) =>
      (await pullNow(env.names(queue).subscription)).map(
        (m) => JSON.parse(Buffer.from(m.message.data, 'base64').toString()).jobId
      );
    expect((await jobs('hot')).sort()).toEqual(['h1', 'h2']);
    expect(await jobs('cold')).toEqual(['c1']);

    // The subscription the transport reads is the hot topic's: a worker gets a bell rung afterwards.
    const seen: Delivery[] = [];
    const sub = transport.subscribe(
      'hot',
      async (delivery) => {
        seen.push(delivery);
        await delivery.ack();
      },
      { capacity: () => 10 }
    );
    await transport.ring([bell('hot', 'h3')]);
    await waitFor(() => seen.some((d) => d.bell?.jobId === 'h3'), 'the hot bell');
    await sub.close();
  });

  test('a queue cannot change topic under its subscription, and removeQueue takes the topic too', async () => {
    await expect(ensureQueue(env.pubsub, env.namespace, 'cold', { hot: true })).rejects.toThrow(
      TransportError
    );
    await removeQueue(env.pubsub, env.namespace, 'hot');
    const [topics] = await env.pubsub.getTopics();
    expect(topics.map((t) => t.name.split('/').pop())).not.toContain(
      queueNames(env.namespace, 'hot', true).topic
    );
    // Moved: removed, then made again on the other topic.
    await removeQueue(env.pubsub, env.namespace, 'cold');
    await ensureQueue(env.pubsub, env.namespace, 'cold', { hot: true });
    await ensureQueue(env.pubsub, env.namespace, 'cold', { hot: true });
  });

  test('a hot queue that cannot be a topic name is refused when the transport is built', () => {
    expect(
      () =>
        new PubSubTransport({
          namespace: env.namespace,
          client: env.pubsub,
          hotQueues: ['q'.repeat(300)],
        })
    ).toThrow(TransportError);
  });
});
