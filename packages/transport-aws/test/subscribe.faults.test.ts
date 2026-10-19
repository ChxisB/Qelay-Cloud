import { expect, setDefaultTimeout, test } from 'bun:test';
import { PurgeQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Bell, Delivery } from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { deadLetterCount, describeSqs, waitFor, withTransport } from './support';

setDefaultTimeout(30_000);

const bell = (namespace: string, jobId: string, queue = 'q'): Bell => ({ namespace, queue, jobId });
const ringOne = (namespace: string, jobId: string, deliverAfterMs?: number) => ({
  bell: bell(namespace, jobId),
  ...(deliverAfterMs === undefined ? {} : { deliverAfterMs }),
});

describeSqs('subscriptions on the SQS emulator: faults and shutdown', () => {
  test('a handler that throws, or returns without settling, gives the bell back at once', async () => {
    await withTransport(async ({ env, transport, errors }) => {
      await transport.ring([ringOne(env.namespace, 'a'), ringOne(env.namespace, 'b')]);
      const times = new Map<string, number[]>();
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          const id = delivery.bell?.jobId ?? '';
          const list = times.get(id) ?? [];
          list.push(Date.now());
          times.set(id, list);
          if (list.length === 1) {
            if (id === 'a') throw new Error('handler failed');
            return;
          }
          await delivery.ack();
        },
        { capacity: () => 2 }
      );
      await waitFor(
        () => (times.get('a')?.length ?? 0) >= 2 && (times.get('b')?.length ?? 0) >= 2,
        'the second deliveries',
        10_000
      );
      await sub.close();
      for (const list of times.values()) {
        // Well inside the 3 s claim window: nack(0), not a wait for the timeout.
        expect(list[1]! - list[0]!).toBeLessThan(2_000);
      }
      expect(errors.some((line) => line.includes('handler failed'))).toBe(true);
    });
  });

  test('a capacity function that throws is reported and read as no room', async () => {
    await withTransport(async ({ env, transport, errors }) => {
      await transport.ring([ringOne(env.namespace, 'a')]);
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          await delivery.ack();
        },
        {
          capacity: () => {
            throw new Error('no capacity answer');
          },
        }
      );
      await Bun.sleep(400);
      expect(transport.metrics.received).toBe(0);
      expect(errors.some((line) => line.includes('no capacity answer'))).toBe(true);
      await sub.close();
    });
  });

  test('a body that is not a bell reaches the handler as no bell and dead-letters when nacked', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await env.client.send(
          new SendMessageCommand({
            QueueUrl: env.provisioned('q').queueUrl,
            MessageBody: 'not json',
          })
        );
        const good: string[] = [];
        let nulls = 0;
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            if (delivery.bell === null) {
              nulls += 1;
              await delivery.nack(0);
              return;
            }
            good.push(delivery.bell.jobId ?? '');
            await delivery.ack();
          },
          { capacity: () => 5 }
        );
        await transport.ring([ringOne(env.namespace, 'good')]);
        // The bad message does not hold the good one back, and it ends up in the dead-letter queue.
        await waitFor(() => good.length === 1, 'the good bell');
        await waitFor(
          async () => (await deadLetterCount(env, 'q')) === 1,
          'the dead letter',
          20_000
        );
        await sub.close();
        expect(nulls).toBeGreaterThanOrEqual(5);
        expect((await transport.stats('q')).deadLetterDepth).toBe(1);
      },
      { queue: { maxReceiveCount: 5 } }
    );
  });

  test('close waits for a handler that is running, and its ack still lands', async () => {
    await withTransport(async ({ env, transport }) => {
      await transport.ring([ringOne(env.namespace, 'a')]);
      let finished = false;
      let started = false;
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          started = true;
          await Bun.sleep(700);
          finished = true;
          await delivery.ack();
        },
        { capacity: () => 1 }
      );
      await waitFor(() => started, 'the handler');
      await sub.close();
      expect(finished).toBe(true);
      const stats = await transport.stats('q');
      expect(stats.depth).toBe(0);
      expect(stats.inFlight).toBe(0);
    });
  });

  test('close gives back the bells it was holding for capacity, immediately', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await transport.ring(Array.from({ length: 3 }, (_, n) => ringOne(env.namespace, `j${n}`)));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let running = 0;
        let asked = 0;
        // Room for three on the first ask, then one slot, which the first handler takes: two bells are
        // received and held with nowhere to run.
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            running += 1;
            await gate;
            await delivery.ack();
          },
          { capacity: () => (asked++ === 0 ? 3 : 1 - running) }
        );
        await waitFor(() => transport.metrics.received === 3, 'three received');
        await sub.close();
        // One is still in flight (its handler did not finish within the close budget); two came back.
        const stats = await transport.stats('q');
        expect(stats.depth).toBe(2);
        expect(stats.inFlight).toBe(1);
        release();
      },
      { transport: { closeTimeoutMs: 300 } }
    );
  });

  test('a stale receipt handle is counted and neither fails the handler nor is reported', async () => {
    await withTransport(
      async ({ env, transport, errors }) => {
        await transport.ring([ringOne(env.namespace, 'a')]);
        let delivery: Delivery | null = null;
        const sub = transport.subscribe(
          'q',
          async (received) => {
            delivery = received;
            await Bun.sleep(100);
            // The message disappears under the handler, as when another worker's ack beat this one.
            await env.client.send(
              new PurgeQueueCommand({ QueueUrl: env.provisioned('q').queueUrl })
            );
            await received.ack();
          },
          { capacity: () => 1 }
        );
        await waitFor(() => delivery !== null && transport.metrics.deletedBells === 1, 'the ack');
        await sub.close();
        const { staleHandles, deleteErrors } = transport.metrics;
        // The emulator answers a delete of a missing message with an error SQS would not raise; either
        // way it is not a failure of the handler and not a line in the log.
        expect(staleHandles + deleteErrors).toBeLessThanOrEqual(1);
        expect(deleteErrors).toBe(0);
        expect(errors.filter((line) => line.startsWith('receive:'))).toEqual([]);
      },
      { transport: { visibilityTimeoutSeconds: 3 } }
    );
  });

  test('subscribing after close is a configuration error, not a silent no-op', async () => {
    await withTransport(async ({ transport }) => {
      await transport.close();
      expect(() => transport.subscribe('q', async () => {}, { capacity: () => 1 })).toThrow(
        TransportError
      );
    });
  });
});
