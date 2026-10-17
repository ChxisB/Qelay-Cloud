import { expect } from 'bun:test';
import { canPeekDeadLetters } from '@qelay-cloud/core';
import { FaultyTransport } from '../support/faults/faultyTransport';
import type { ContractContext } from './context';
import { bell, collect, jobIds, until } from './context';

/**
 * A broker that misbehaves, made to by `FaultyTransport` at the boundary so the same fault is applied
 * to memory, Postgres, Pub/Sub and SQS alike. The contract is the same for all: a fault may delay a
 * bell or repeat it, it may not lose work the store still has, and it may not make the worker
 * fail.
 */
export function faultContract({ it, optional, using }: ContractContext): void {
  it('brings a bell back when its ack never reached the broker', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      const faulty = new FaultyTransport(transport);
      faulty.dropAckNext(1);
      const { seen, subscription } = collect(faulty, 'q', 5);
      await faulty.ring([{ bell: bell('q', 'job-1') }]);
      await until(async () => {
        await settle();
        return seen.length >= 1;
      }, 'the first delivery');
      await advance(redeliveryAfterMs);
      await until(async () => {
        await settle();
        return seen.length >= 2;
      }, 'the redelivery after the lost ack');
      expect(faulty.counts.acksDropped).toBe(1);
      expect(new Set(jobIds(seen))).toEqual(new Set(['job-1']));
      await subscription.close();
      faulty.release();
    });
  });

  it('delivers a bell rung twice at least once and at most twice, and survives acking both', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport);
      faulty.duplicateNext(1);
      const { seen, subscription } = collect(faulty, 'q', 5);
      await faulty.ring([{ bell: bell('q', 'twice') }]);
      await until(async () => {
        await settle();
        return seen.length >= 1;
      }, 'the bell');
      await settle();
      await settle();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.length).toBeLessThanOrEqual(2);
      expect(faulty.counts.duplicated).toBe(1);
      await subscription.close();
      faulty.release();
    });
  });

  it('survives a handler that sees the same delivery twice', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport);
      faulty.duplicateDeliveryNext(1);
      const { seen, subscription } = collect(faulty, 'q', 5, async (delivery) => {
        await delivery.ack();
      });
      await faulty.ring([{ bell: bell('q', 'twice') }]);
      await until(async () => {
        await settle();
        return seen.length >= 2;
      }, 'both calls of the handler');
      expect(faulty.counts.deliveriesDuplicated).toBe(1);
      await subscription.close();
      faulty.release();
    });
  });

  it('delivers a late bell after its lag, and answers the ring at once', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport, { lateMs: 600 });
      faulty.delayNext(600, 1);
      const { seen, subscription } = collect(faulty, 'q', 5);
      const started = Date.now();
      const results = await faulty.ring([{ bell: bell('q', 'slow') }]);
      expect(results).toEqual([{ ok: true }]);
      expect(Date.now() - started).toBeLessThan(500);
      await settle();
      if (Date.now() - started < 550) expect(seen).toHaveLength(0);
      await until(async () => {
        await settle();
        return seen.length === 1;
      }, 'the late bell');
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
      await subscription.close();
      faulty.release();
    });
  });

  it('delivers every bell of a batch that was rung backwards', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport);
      faulty.reorderNext(1);
      const { seen, subscription } = collect(faulty, 'q', 5);
      const results = await faulty.ring(['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) })));
      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      await until(async () => {
        await settle();
        return seen.length >= 3;
      }, 'all three bells');
      expect(jobIds(seen).toSorted()).toEqual(['a', 'b', 'c']);
      await subscription.close();
      faulty.release();
    });
  });

  it('delivers every bell when the broker hands them to the handler in reverse', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport);
      faulty.reorderDeliveriesNext(3, 2_000);
      const { seen, subscription } = collect(faulty, 'q', 5);
      await faulty.ring(['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) })));
      await until(async () => {
        await settle();
        return seen.length >= 3;
      }, 'all three bells');
      expect(jobIds(seen).toSorted()).toEqual(['a', 'b', 'c']);
      await subscription.close();
      faulty.release();
    });
  });

  it('keeps a lost ring lost until it is rung again: the transport has no memory of it', async () => {
    await using(async ({ transport, settle }) => {
      const faulty = new FaultyTransport(transport);
      faulty.dropNext(1);
      const { seen, subscription } = collect(faulty, 'q', 5);
      expect(await faulty.ring([{ bell: bell('q', 'lost') }])).toEqual([{ ok: true }]);
      await settle();
      await settle();
      expect(seen).toHaveLength(0);
      await faulty.ring([{ bell: bell('q', 'lost') }]);
      await until(async () => {
        await settle();
        return seen.length === 1;
      }, 'the bell once it is rung again');
      await subscription.close();
      faulty.release();
    });
  });

  optional(
    'poison',
    'sends a body that is not a bell to the dead-letter queue, counts it and never replays it',
    async () => {
      await using(async ({ transport, settle, poison, deadLetterAfterMs }) => {
        expect(poison).toBeDefined();
        const deliveries: Array<{ bell: unknown }> = [];
        const subscription = transport.subscribe(
          'q',
          async (delivery) => {
            deliveries.push({ bell: delivery.bell });
            await delivery.nack(0);
          },
          { capacity: () => 5 }
        );
        await poison?.('q');
        const peek = canPeekDeadLetters(transport) ? transport : null;
        expect(peek).not.toBeNull();
        await until(
          async () => (await peek?.peekDeadLetters('q', 10))?.length === 1,
          'the poison bell in the dead-letter queue',
          deadLetterAfterMs ?? 30_000
        );
        const [letter] = (await peek?.peekDeadLetters('q', 10)) ?? [];
        expect(letter?.bell).toBeNull();
        expect(deliveries.length).toBeGreaterThanOrEqual(1);
        expect(deliveries.every((delivery) => delivery.bell === null)).toBe(true);
        // A dead letter is a metric and never replayed: nothing is delivered after it landed.
        const before = deliveries.length;
        await settle();
        await settle();
        expect(deliveries).toHaveLength(before);
        // `null` is "unknown" (an emulator without monitoring), and is allowed; a zero is not.
        const stats = await transport.stats('q');
        if (stats.deadLetterDepth !== null) expect(stats.deadLetterDepth).toBeGreaterThanOrEqual(1);
        await subscription.close();
      });
    },
    true
  );

  optional(
    'outage',
    'reconnects after the network to the broker fails, on the subscription it already had',
    async () => {
      await using(async ({ transport, settle, outage }) => {
        expect(outage).toBeDefined();
        const { seen, subscription } = collect(transport, 'q', 5);
        await transport.ring([{ bell: bell('q', 'before') }]);
        await until(async () => {
          await settle();
          return jobIds(seen).includes('before');
        }, 'a bell before the outage');

        await outage?.sever();
        // During the outage a ring must not claim success it cannot have: that is what the tick is for.
        const during = await transport.ring([{ bell: bell('q', 'during') }]).catch(() => null);
        expect(during === null || during.every((result) => !result.ok)).toBe(true);
        await Bun.sleep(1_000);
        await outage?.restore();

        await until(
          async () => {
            const rung = await transport.ring([{ bell: bell('q', 'after') }]).catch(() => null);
            await settle();
            return rung?.every((result) => result.ok) === true && jobIds(seen).includes('after');
          },
          'a bell after the network came back',
          45_000
        );
        await subscription.close();
      });
    },
    true
  );
}
