import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Bell, Delivery } from '@qelay-cloud/core';
import { ensureQueue, PubSubTransport, removeQueue } from '../src';
import type { Environment } from './support';
import { describePubsub, FAST_TOPOLOGY, openEnvironment, pullNow, waitFor } from './support';

let env: Environment;
let errors: { error: Error; source: string }[];
const open: PubSubTransport[] = [];

const bell = (jobId: string, queue = 'q'): Bell => ({ namespace: env.namespace, queue, jobId });

function make(
  options: Partial<ConstructorParameters<typeof PubSubTransport>[0]> = {}
): PubSubTransport {
  const transport = new PubSubTransport({
    namespace: env.namespace,
    client: env.pubsub,
    onError: (error, source) => errors.push({ error, source }),
    ...options,
  });
  open.push(transport);
  return transport;
}

describePubsub('PubSubTransport.subscribe', () => {
  beforeEach(async () => {
    env = await openEnvironment({ queues: ['q'] });
    errors = [];
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((transport) => transport.close()));
    await env.destroy();
  });

  test('a bell that finds no capacity waits un-acked, and is not nacked into the dead-letter policy', async () => {
    const transport = make();
    let room = 0;
    const seen: Delivery[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        await delivery.ack();
      },
      { capacity: () => room }
    );
    await transport.ring(['a', 'b', 'c'].map((id) => ({ bell: bell(id) })));
    await Bun.sleep(1_800);
    expect(seen).toHaveLength(0);
    room = 3;
    sub.refresh();
    await waitFor(() => seen.length === 3, 'the three bells');
    // Had they been nacked while the worker was busy, each would be on its second or third attempt.
    expect(seen.map((d) => d.attempt ?? 1)).toEqual([1, 1, 1]);
    await sub.close();
  });

  test('close returns promptly and gives back every bell, also when more came than maxHeld', async () => {
    const transport = make({ maxHeld: 3 });
    const sub = transport.subscribe('q', async () => {}, { capacity: () => 0 });
    await transport.ring(Array.from({ length: 12 }, (_, n) => ({ bell: bell(`job-${n}`) })));
    await Bun.sleep(1_200);
    const started = Date.now();
    await sub.close();
    // The client's own close waits out its whole timeout for bells it kept past the flow-control limit.
    expect(Date.now() - started).toBeLessThan(3_000);
    await Bun.sleep(1_500);
    expect(await pullNow(env.names('q').subscription, 100)).toHaveLength(12);
  });

  // The emulator sends every bell whatever the flow-control limit says (measured: 30 of 30 held with
  // maxHeld 3), so how many bells a process hoards while it has no capacity can only be checked
  // against the service. Recorded in the task 17 Result as not verified.
  test.todo('a subscriber holds about maxHeld bells, and the rest stay visible to other workers', () => {});

  test('capacity that throws counts as none, and is reported', async () => {
    const transport = make();
    const seen: Delivery[] = [];
    let broken = true;
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        await delivery.ack();
      },
      {
        capacity: () => {
          if (broken) throw new Error('capacity broke');
          return 5;
        },
      }
    );
    await transport.ring([{ bell: bell('a') }]);
    await waitFor(() => errors.some((e) => e.error.message === 'capacity broke'), 'the report');
    expect(seen).toHaveLength(0);
    broken = false;
    sub.refresh();
    await waitFor(() => seen.length === 1, 'the bell');
    await sub.close();
  });

  test('a handler that throws gives the bell back and reports, without stopping the subscription', async () => {
    const transport = make();
    const seen: Delivery[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        if (seen.length === 1) throw new Error('claim failed');
        await delivery.ack();
      },
      { capacity: () => 5 }
    );
    await transport.ring([{ bell: bell('a') }]);
    await waitFor(() => seen.length === 2, 'the redelivery');
    expect(errors.filter((e) => e.source === 'receive').map((e) => e.error.message)).toContain(
      'claim failed'
    );
    expect(seen[1]?.attempt ?? 2).toBe(2);
    await sub.close();
  });

  test('nack(retryInMs) keeps the bell for that long, so a held bell burns no delivery attempt', async () => {
    const transport = make();
    const times: number[] = [];
    const attempts: (number | null)[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        times.push(Date.now());
        attempts.push(delivery.attempt);
        if (times.length === 1) await delivery.nack(2_000);
        else await delivery.ack();
      },
      { capacity: () => 5 }
    );
    await transport.ring([{ bell: bell('a') }]);
    await waitFor(() => times.length === 2, 'the redelivery', 15_000);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(1_900);
    // One nack, released after the hold: the second delivery is the second attempt, not the fifth.
    expect(attempts[1] ?? 2).toBe(2);
    await sub.close();
  });

  test('a retry hint is capped, so one bell cannot be held for an hour', async () => {
    const transport = make({ maxNackHoldMs: 300 });
    const times: number[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        times.push(Date.now());
        if (times.length === 1) await delivery.nack(3_600_000);
        else await delivery.ack();
      },
      { capacity: () => 5 }
    );
    await transport.ring([{ bell: bell('a') }]);
    await waitFor(() => times.length === 2, 'the redelivery', 10_000);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeLessThan(5_000);
    await sub.close();
  });

  test('a bell that is not a bell dead-letters after the policy limit when the worker nacks it', async () => {
    const transport = make();
    const attempts: (number | null)[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        expect(delivery.bell).toBeNull();
        attempts.push(delivery.attempt);
        await delivery.nack(0);
      },
      { capacity: () => 5 }
    );
    await env.pubsub.topic(`qcloud.${env.namespace}.bells`).publishMessage({
      data: Buffer.from('garbage'),
      attributes: { route: env.names('q').route },
    });
    const dead = env.names('q').deadLetterSubscription;
    let found: Awaited<ReturnType<typeof pullNow>> = [];
    await waitFor(async () => (found = await pullNow(dead)).length > 0, 'the dead letter', 40_000);
    expect(Buffer.from(found[0]?.message.data ?? '', 'base64').toString()).toBe('garbage');
    expect(attempts).toHaveLength(FAST_TOPOLOGY.maxDeliveryAttempts ?? 5);
    await sub.close();
  }, 60_000);

  test('close waits for the handler that is running, and its ack goes out', async () => {
    const transport = make();
    let finished = false;
    const seen: Delivery[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        await Bun.sleep(700);
        await delivery.ack();
        finished = true;
      },
      { capacity: () => 5 }
    );
    await transport.ring([{ bell: bell('a') }]);
    await waitFor(() => seen.length === 1, 'the handler to start');
    await sub.close();
    expect(finished).toBe(true);
    await Bun.sleep(2_500);
    expect(await pullNow(env.names('q').subscription)).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  test('close gives back the bells that were waiting, for another worker to take', async () => {
    const first = make();
    const sub = first.subscribe('q', async () => {}, { capacity: () => 0 });
    await first.ring(['a', 'b'].map((id) => ({ bell: bell(id) })));
    await Bun.sleep(1_000);
    await sub.close();
    const second = make();
    const seen: Delivery[] = [];
    const other = second.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        await delivery.ack();
      },
      { capacity: () => 5 }
    );
    await waitFor(() => seen.length === 2, 'the bells to reach the second worker', 8_000);
    await other.close();
  });

  test('a subscription that was missing is picked up again once it exists, without a restart', async () => {
    const transport = make({ streamRestartMs: 100 });
    const seen: Delivery[] = [];
    const sub = transport.subscribe(
      'q',
      async (delivery) => {
        seen.push(delivery);
        await delivery.ack();
      },
      { capacity: () => 5 }
    );
    await Bun.sleep(500);
    await removeQueue(env.pubsub, env.namespace, 'q');
    await waitFor(() => errors.some((e) => e.source === 'receive'), 'the stream error', 15_000);
    await ensureQueue(env.pubsub, env.namespace, 'q', FAST_TOPOLOGY);
    await transport.ring([{ bell: bell('after') }]);
    await waitFor(() => seen.length === 1, 'the bell after recovery', 30_000);
    expect(seen[0]?.bell?.jobId).toBe('after');
    await sub.close();
  }, 60_000);

  test('close is safe to repeat, and a subscription closed first does not break the transport close', async () => {
    const transport = make();
    const sub = transport.subscribe('q', async () => {}, { capacity: () => 1 });
    await sub.close();
    await sub.close();
    await transport.close();
    await transport.close();
  });
});
