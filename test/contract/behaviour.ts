import { expect } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import type { ContractContext, Gate } from './context';
import { bell, collect, gate, jobIds, until } from './context';

/**
 * What a worker relies on beyond the happy path: a failed handler is not a lost bell, a bell nobody
 * needs is gone for good, concurrency stays inside the bound, and shutting down does not abandon work.
 */
export function behaviourContract({ it, using }: ContractContext): void {
  it('redelivers a bell whose handler threw: at-least-once, not at-most-once', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      let calls = 0;
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          calls += 1;
          if (calls === 1) throw new Error('the handler failed (made to by the test)');
          await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await until(async () => {
        await settle();
        return calls >= 1;
      }, 'the first delivery');
      // A failure is not a loss: the bell is back within the time a transport declares for that.
      await advance(redeliveryAfterMs);
      await until(async () => {
        await settle();
        return calls >= 2;
      }, 'the bell to come back after the handler threw');
      await subscription.close();
    });
  });

  it('runs up to the capacity it is given at once, and no more', async () => {
    await using(async ({ transport, settle }) => {
      const capacity = 3;
      let running = 0;
      let peak = 0;
      let finished = 0;
      const gates: Gate[] = [];
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          running += 1;
          peak = Math.max(peak, running);
          const held = gate();
          gates.push(held);
          await held.open;
          running -= 1;
          finished += 1;
          await delivery.ack();
        },
        { capacity: () => capacity - running }
      );
      await transport.ring(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ bell: bell('q', id) })));
      await until(async () => {
        await settle();
        return running === capacity;
      }, 'the handlers to fill the capacity');
      await settle();
      expect(running).toBe(capacity);
      for (let round = 0; finished < 6 && round < 30; round += 1) {
        for (const held of gates) held.release();
        subscription.refresh();
        await settle();
      }
      expect(finished).toBe(6);
      expect(peak).toBe(capacity);
      await subscription.close();
    });
  });

  it('close waits for a handler that is running, and its ack goes out', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      const held = gate();
      let started = 0;
      let finished = 0;
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          started += 1;
          await held.open;
          await delivery.ack();
          finished += 1;
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'in-flight') }]);
      await until(async () => {
        await settle();
        return started === 1;
      }, 'the handler to start');
      const closing = subscription.close();
      await Bun.sleep(50);
      held.release();
      await closing;
      expect(finished).toBe(1);
      // The ack reached the broker before close returned: the bell does not come back.
      await advance(redeliveryAfterMs + 50);
      await settle();
      expect(started).toBe(1);
    });
  });

  it('does not redeliver a bell that was acked while its handler is still working', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      const held = gate();
      const { seen, subscription } = collect(transport, 'q', 5, async (delivery) => {
        // Acknowledge first, work after: what a worker does with a long job.
        await delivery.ack();
        await held.open;
      });
      await transport.ring([{ bell: bell('q', 'long') }]);
      await until(async () => {
        await settle();
        return seen.length === 1;
      }, 'the bell');
      await advance(redeliveryAfterMs * 2);
      await settle();
      expect(seen).toHaveLength(1);
      held.release();
      await subscription.close();
    });
  });

  it('lets a bell that finds nothing to do go: acked once, never redelivered, never dead-lettered', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      // The worker looks the job up, finds none (done, deleted, claimed elsewhere) and acks.
      const { seen, subscription } = collect(transport, 'q', 5, (delivery) => delivery.ack());
      await transport.ring([{ bell: bell('q', 'gone') }]);
      await until(async () => {
        await settle();
        return seen.length === 1;
      }, 'the bell');
      await advance(redeliveryAfterMs + 50);
      await settle();
      expect(jobIds(seen)).toEqual(['gone']);
      const stats = await transport.stats('q');
      if (stats.deadLetterDepth !== null) expect(stats.deadLetterDepth).toBe(0);
      await subscription.close();
    });
  });

  it('keeps a queue its own: a bell for A never reaches a subscriber of B, in either direction', async () => {
    await using(async ({ transport, settle }) => {
      const a = collect(transport, 'q1', 5);
      const b = collect(transport, 'q2', 5);
      await transport.ring([
        { bell: bell('q1', 'for-a') },
        { bell: bell('q2', 'for-b') },
        { bell: bell('q1', 'for-a-too') },
      ]);
      await until(async () => {
        await settle();
        return a.seen.length >= 2 && b.seen.length >= 1;
      }, 'both queues to receive their bells');
      await settle();
      expect(jobIds(a.seen).toSorted()).toEqual(['for-a', 'for-a-too']);
      expect(jobIds(b.seen)).toEqual(['for-b']);
      const wrong: Delivery[] = [...a.seen, ...b.seen].filter(
        (d) => d.bell !== null && !['q1', 'q2'].includes(d.bell.queue)
      );
      expect(wrong).toEqual([]);
      await a.subscription.close();
      await b.subscription.close();
    });
  });
}
