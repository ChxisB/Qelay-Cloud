import { expect, setDefaultTimeout, test } from 'bun:test';
import type { Bell } from '@qelay-cloud/core';
import { describeSqs, waitFor, withTransport } from './support';

setDefaultTimeout(30_000);

const bell = (namespace: string, jobId: string, queue = 'q'): Bell => ({ namespace, queue, jobId });
const ringOne = (namespace: string, jobId: string, deliverAfterMs?: number) => ({
  bell: bell(namespace, jobId),
  ...(deliverAfterMs === undefined ? {} : { deliverAfterMs }),
});

describeSqs('receive on the SQS emulator', () => {
  test('takes at most ten bells per receive and delivers every one once', async () => {
    await withTransport(async ({ env, transport }) => {
      const seen: string[] = [];
      await transport.ring(Array.from({ length: 25 }, (_, n) => ringOne(env.namespace, `j${n}`)));
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          seen.push(delivery.bell?.jobId ?? '');
          await delivery.ack();
        },
        { capacity: () => 100 }
      );
      await waitFor(() => seen.length >= 25, '25 deliveries');
      await sub.close();
      expect(new Set(seen).size).toBe(25);
      expect(seen).toHaveLength(25);
      expect(transport.metrics.largestReceive).toBeLessThanOrEqual(10);
      expect(transport.metrics.deletedBells).toBe(25);
      expect(transport.metrics.deletes).toBeLessThan(25);
    });
  });

  test('reports the attempt number from the receive count', async () => {
    await withTransport(async ({ env, transport }) => {
      await transport.ring([ringOne(env.namespace, 'a')]);
      const attempts: (number | null)[] = [];
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          attempts.push(delivery.attempt);
          if (attempts.length < 3) await delivery.nack(0);
          else await delivery.ack();
        },
        { capacity: () => 1 }
      );
      await waitFor(() => attempts.length >= 3, 'three deliveries');
      await sub.close();
      expect(attempts).toEqual([1, 2, 3]);
    });
  });

  test('asks for nothing while the worker is full, and again when it refreshes', async () => {
    await withTransport(async ({ env, transport }) => {
      await transport.ring(Array.from({ length: 5 }, (_, n) => ringOne(env.namespace, `j${n}`)));
      let room = 0;
      const seen: string[] = [];
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          seen.push(delivery.bell?.jobId ?? '');
          await delivery.ack();
        },
        { capacity: () => room }
      );
      await Bun.sleep(1_500);
      // The backlog stays where the stats and the other workers can see it.
      expect(transport.metrics.received).toBe(0);
      expect((await transport.stats('q')).depth).toBe(5);
      room = 2;
      sub.refresh();
      await waitFor(() => seen.length === 5, 'the backlog');
      await sub.close();
      expect(transport.metrics.largestReceive).toBeLessThanOrEqual(2);
    });
  });

  test('a bell that arrives while the worker is busy waits and is delivered, not nacked', async () => {
    await withTransport(async ({ env, transport }) => {
      await transport.ring([ringOne(env.namespace, 'a'), ringOne(env.namespace, 'b')]);
      let running = 0;
      let maxRunning = 0;
      const seen: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await gate;
          seen.push(delivery.bell?.jobId ?? '');
          running -= 1;
          await delivery.ack();
        },
        { capacity: () => 1 - running }
      );
      await Bun.sleep(1_000);
      expect(running).toBe(1);
      release();
      await waitFor(() => seen.length === 2, 'both bells');
      await sub.close();
      expect(maxRunning).toBe(1);
      expect(transport.metrics.nacks).toBe(0);
    });
  });

  test('a long poll wakes for a bell at once, and close ends a poll in flight at once', async () => {
    await withTransport(
      async ({ env, transport }) => {
        const seen: string[] = [];
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            seen.push(delivery.bell?.jobId ?? '');
            await delivery.ack();
          },
          { capacity: () => 5 }
        );
        await Bun.sleep(300);
        const rung = Date.now();
        await transport.ring([ringOne(env.namespace, 'a')]);
        await waitFor(() => seen.length === 1, 'the bell', 5_000, 10);
        expect(Date.now() - rung).toBeLessThan(2_000);
        const closing = Date.now();
        await sub.close();
        expect(Date.now() - closing).toBeLessThan(1_000);
      },
      { transport: { waitSeconds: 20 } }
    );
  });

  test('nack(retryInMs) hides the bell for that time rounded up to whole seconds', async () => {
    await withTransport(async ({ env, transport }) => {
      await transport.ring([ringOne(env.namespace, 'a')]);
      const at: number[] = [];
      const sub = transport.subscribe(
        'q',
        async (delivery) => {
          at.push(Date.now());
          if (at.length === 1) await delivery.nack(1_200);
          else await delivery.ack();
        },
        { capacity: () => 1 }
      );
      await waitFor(() => at.length === 2, 'the retry');
      await sub.close();
      const gap = at[1]! - at[0]!;
      // 1,200 ms is 2 s at one-second granularity; the broker may take a little longer, never less.
      expect(gap).toBeGreaterThanOrEqual(1_800);
      expect(gap).toBeLessThan(5_000);
    });
  });

  test('a nack is never undone by a heartbeat that was already on its way', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await transport.ring([ringOne(env.namespace, 'a')]);
        const at: number[] = [];
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            at.push(Date.now());
            // One heartbeat has been sent by now (every third of the 3 s claim window).
            await Bun.sleep(1_200);
            await delivery.nack(6_000);
          },
          { capacity: () => 1 }
        );
        await waitFor(() => at.length === 1, 'the first delivery');
        await Bun.sleep(4_500);
        // Undone by a late heartbeat it would be back after about 3 s.
        expect(at).toHaveLength(1);
        await waitFor(() => at.length === 2, 'the retry', 10_000);
        expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(6_500);
        await sub.close();
      },
      { transport: { visibilityTimeoutSeconds: 3 } }
    );
  });

  test('a nack is capped at maxNackHoldMs', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await transport.ring([ringOne(env.namespace, 'a')]);
        const at: number[] = [];
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            at.push(Date.now());
            if (at.length === 1) await delivery.nack(3_600_000);
            else await delivery.ack();
          },
          { capacity: () => 1 }
        );
        await waitFor(() => at.length === 2, 'the retry', 10_000);
        await sub.close();
      },
      { transport: { maxNackHoldMs: 1_000 } }
    );
  });
});
