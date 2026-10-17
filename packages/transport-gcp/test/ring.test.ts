import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PubSub } from '@google-cloud/pubsub';
import type { Bell, Delivery } from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { GRPC_ONLY, PubSubTransport } from '../src';
import type { Environment } from './support';
import { describePubsub, EMULATOR_PROJECT, openEnvironment, waitFor } from './support';

const bell = (queue: string, jobId?: string, namespace = env.namespace): Bell =>
  jobId === undefined ? { namespace, queue } : { namespace, queue, jobId };

let env: Environment;
let transport: PubSubTransport;
let errors: { error: Error; source: string }[];

describePubsub('PubSubTransport.ring', () => {
  beforeEach(async () => {
    env = await openEnvironment({ queues: ['q', 'other'] });
    errors = [];
    transport = new PubSubTransport({
      namespace: env.namespace,
      client: env.pubsub,
      onError: (error, source) => errors.push({ error, source }),
    });
  });
  afterEach(async () => {
    await transport.close();
    await env.destroy();
  });

  function collect(queue: string, into: Delivery[]) {
    return transport.subscribe(
      queue,
      async (delivery) => {
        into.push(delivery);
        await delivery.ack();
      },
      { capacity: () => 100 }
    );
  }

  test('a batch with items that cannot be rung still rings the others, and says which', async () => {
    const seen: Delivery[] = [];
    const sub = collect('q', seen);
    const results = await transport.ring([
      { bell: bell('q', 'ok-1') },
      { bell: bell('q', 'delayed'), deliverAfterMs: 1 },
      { bell: bell('q', 'foreign', 'another-environment') },
      { bell: bell('q', 'not-a-number'), deliverAfterMs: Number.NaN },
      { bell: bell('', 'no-queue') },
      { bell: bell('q', 'ok-2') },
    ]);
    expect(results).toEqual([
      { ok: true },
      { ok: false, reason: 'delay-too-long' },
      { ok: false, reason: 'rejected' },
      { ok: false, reason: 'rejected' },
      { ok: false, reason: 'rejected' },
      { ok: true },
    ]);
    await waitFor(() => seen.length >= 2, 'both rung bells');
    await Bun.sleep(300);
    expect(seen.map((d) => d.bell?.jobId).sort()).toEqual(['ok-1', 'ok-2']);
    expect(errors.map((e) => e.source)).toEqual(['ring']);
    await sub.close();
  });

  test('a delay of 0 or less is no delay, and a fraction of a millisecond rounds up to one', async () => {
    const results = await transport.ring([
      { bell: bell('q', 'a'), deliverAfterMs: 0 },
      { bell: bell('q', 'b'), deliverAfterMs: -5 },
      { bell: bell('q', 'c'), deliverAfterMs: 0.2 },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: false, reason: 'delay-too-long' }]);
  });

  test('rings an empty batch without a request', async () => {
    expect(await transport.ring([])).toEqual([]);
  });

  test('rings more bells than one publish request holds, all of them', async () => {
    const seen: Delivery[] = [];
    const sub = collect('q', seen);
    const items = Array.from({ length: 1_250 }, (_, n) => ({ bell: bell('q', `job-${n}`) }));
    const results = await transport.ring(items);
    expect(results.every((r) => r.ok)).toBe(true);
    await waitFor(() => seen.length >= 1_250, 'every bell', 30_000);
    expect(new Set(seen.map((d) => d.bell?.jobId)).size).toBe(1_250);
    await sub.close();
  }, 60_000);

  test('an environment with no topic is unreachable, quickly, and reported once', async () => {
    const lost = new PubSubTransport({
      namespace: 'never-created',
      client: env.pubsub,
      ringRetryBudgetMs: 5_000,
      onError: (error, source) => errors.push({ error, source }),
    });
    const started = Date.now();
    const results = await lost.ring([
      { bell: bell('q', 'a', 'never-created') },
      { bell: bell('q', 'b', 'never-created') },
    ]);
    expect(results).toEqual([
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'unreachable' },
    ]);
    // NOT_FOUND is not transient: it must not spend the retry budget.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe('ring');
    expect(errors[0]?.error.message).not.toContain('"jobId"');
    await lost.close();
  });

  test('an unreachable service is retried for the budget, then reported, never thrown', async () => {
    const dead = new PubSub({
      projectId: EMULATOR_PROJECT,
      apiEndpoint: '127.0.0.1:1',
      emulatorMode: true,
      ...GRPC_ONLY,
    });
    const lost = new PubSubTransport({
      namespace: env.namespace,
      client: dead,
      ringRetryBudgetMs: 1_200,
      onError: (error, source) => errors.push({ error, source }),
    });
    const started = Date.now();
    const results = await lost.ring([{ bell: bell('q', 'a') }, { bell: bell('q', 'b') }]);
    const took = Date.now() - started;
    expect(results).toEqual([
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'unreachable' },
    ]);
    expect(took).toBeGreaterThanOrEqual(1_000);
    expect(took).toBeLessThan(4_000);
    expect(errors).toHaveLength(1);
    await lost.close();
    await dead.close();
  });

  test('a logger that throws does not turn a failed ring into an exception', async () => {
    const lost = new PubSubTransport({
      namespace: 'never-created',
      client: env.pubsub,
      onError: () => {
        throw new Error('logger is down');
      },
    });
    expect(await lost.ring([{ bell: bell('q', 'a', 'never-created') }])).toEqual([
      { ok: false, reason: 'unreachable' },
    ]);
    await lost.close();
  });

  test('a closed transport rings nothing and subscribes to nothing', async () => {
    await transport.close();
    expect(await transport.ring([{ bell: bell('q', 'late') }])).toEqual([
      { ok: false, reason: 'unreachable' },
    ]);
    expect(() => transport.subscribe('q', async () => {}, { capacity: () => 1 })).toThrow(
      TransportError
    );
    await transport.close();
  });

  test('a namespace that cannot be a resource name is a configuration error at construction', () => {
    expect(() => new PubSubTransport({ namespace: '', client: env.pubsub })).toThrow(
      TransportError
    );
  });

  test('a queue is served by its own subscription only, even when names look alike', async () => {
    const names = ['a.b', 'a_2eb', 'a-b'];
    const other = await openEnvironment({ namespace: env.namespace, queues: names });
    const own = new PubSubTransport({ namespace: env.namespace, client: other.pubsub });
    const seen: Record<string, string[]> = {};
    const subs = names.map((queue) =>
      own.subscribe(
        queue,
        async (delivery) => {
          (seen[queue] ??= []).push(delivery.bell?.jobId ?? 'null');
          await delivery.ack();
        },
        { capacity: () => 10 }
      )
    );
    await own.ring(names.map((queue) => ({ bell: bell(queue, `for-${queue}`) })));
    await waitFor(() => names.every((queue) => seen[queue]?.length), 'every queue');
    await Bun.sleep(400);
    expect(seen).toEqual({ 'a.b': ['for-a.b'], a_2eb: ['for-a_2eb'], 'a-b': ['for-a-b'] });
    await Promise.all(subs.map((sub) => sub.close()));
    await own.close();
    await other.destroy();
  });

  test('a body that names another queue than its route is handed over as no bell', async () => {
    const seen: Delivery[] = [];
    const sub = collect('q', seen);
    const topic = env.pubsub.topic(`qcloud.${env.namespace}.bells`);
    const route = env.names('q').route;
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify({ namespace: env.namespace, queue: 'other', jobId: 'x' })),
      attributes: { route },
    });
    await topic.publishMessage({ data: Buffer.from('not a bell'), attributes: { route } });
    await waitFor(() => seen.length >= 2, 'both messages');
    expect(seen.map((d) => d.bell)).toEqual([null, null]);
    await sub.close();
  });
});
