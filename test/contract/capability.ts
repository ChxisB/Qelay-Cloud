import { expect } from 'bun:test';
import { FaultyTransport } from '../support/faults/faultyTransport';
import type { ContractContext } from './context';
import { bell, collect, jobIds, until } from './context';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Tests that depend on what a transport declares. A transport that cannot delay a bell passes the same
 * suite by refusing the delay (`delay-too-long`), never by delivering early; the end-to-end scenario
 * then reaches the same outcome through the tick, with the precision `docs/transports.md` states.
 */
export function capabilityContract({ it, using }: ContractContext): void {
  it('declares one capability set and sticks to it', async () => {
    await using(async ({ transport }) => {
      const first = { ...transport.capabilities };
      expect(Number.isFinite(first.maxRingBatch)).toBe(true);
      expect(Number.isInteger(first.maxRingBatch)).toBe(true);
      expect(first.maxDeliverDelayMs === Infinity || Number.isFinite(first.maxDeliverDelayMs)).toBe(
        true
      );
      expect(Number.isFinite(first.retryGranularityMs)).toBe(true);
      await transport.ring([{ bell: bell('q', 'a') }]);
      expect({ ...transport.capabilities }).toEqual(first);
    });
  });

  it('answers a ring bigger than its batch with one result per item, and delivers every bell', async () => {
    await using(async ({ transport, settle }) => {
      const { maxRingBatch } = transport.capabilities;
      const count = Math.min(maxRingBatch * 2 + 1, 30);
      const { seen, subscription } = collect(transport, 'q', count);
      const ids = Array.from({ length: count }, (_, index) => `job-${index}`);
      const results = await transport.ring(ids.map((id) => ({ bell: bell('q', id) })));
      expect(results).toHaveLength(count);
      expect(results.every((result) => result.ok)).toBe(true);
      await until(async () => {
        await settle();
        return new Set(jobIds(seen)).size === count;
      }, `all ${count} bells`);
      await subscription.close();
    });
  });

  it('reports attempts as it declares, never as a number it does not know', async () => {
    await using(async ({ transport, settle }) => {
      const attempts: Array<number | null> = [];
      let calls = 0;
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          calls += 1;
          attempts.push(delivery.attempt);
          if (calls < 3) await delivery.nack(0);
          else await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await until(async () => {
        await settle();
        return calls >= 3;
      }, 'three deliveries');
      if (transport.capabilities.attemptCount === 'none') {
        expect(attempts).toEqual([null, null, null]);
      } else {
        for (const attempt of attempts) {
          if (attempt !== null) {
            expect(Number.isInteger(attempt)).toBe(true);
            expect(attempt).toBeGreaterThanOrEqual(1);
          }
        }
        const known = attempts.filter((attempt): attempt is number => attempt !== null);
        expect(known).toEqual(known.toSorted((x, y) => x - y));
      }
      await subscription.close();
    });
  });

  it('does not bring a nacked bell back before the retry delay it was given', async () => {
    await using(async ({ transport, settle, advance }) => {
      let calls = 0;
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          calls += 1;
          if (calls === 1) await delivery.nack(1_500);
          else await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await until(async () => {
        await settle();
        return calls === 1;
      }, 'the first delivery');
      await settle();
      expect(calls).toBe(1);
      await advance(1_500 + transport.capabilities.retryGranularityMs);
      await until(async () => {
        await settle();
        return calls >= 2;
      }, 'the retry');
      await subscription.close();
    });
  });

  it('keeps a delayed bell back until its delay has passed, or refuses a delay it has none for', async () => {
    await using(async ({ transport, settle, advance }) => {
      const { seen, subscription } = collect(transport, 'q', 5);
      const [result] = await transport.ring([{ bell: bell('q', 'later'), deliverAfterMs: 400 }]);
      const refused = transport.capabilities.maxDeliverDelayMs < 400;
      // Without a per-message delay (Pub/Sub) the bell is refused, never delivered early.
      expect(result).toEqual(refused ? { ok: false, reason: 'delay-too-long' } : { ok: true });
      await settle();
      expect(seen).toHaveLength(0);
      await advance(500);
      await settle();
      expect(seen).toHaveLength(refused ? 0 : 1);
      await subscription.close();
    });
  });

  it('refuses a delay past its window as delay-too-long, and never clamps it', async () => {
    await using(async ({ transport, settle }) => {
      const { seen, subscription } = collect(transport, 'q', 5);
      const max = transport.capabilities.maxDeliverDelayMs;
      const [result] = await transport.ring([
        { bell: bell('q', 'far'), deliverAfterMs: Number.isFinite(max) ? max + 1 : YEAR_MS },
      ]);
      if (Number.isFinite(max)) {
        expect(result).toEqual({ ok: false, reason: 'delay-too-long' });
        await settle();
        expect(seen).toHaveLength(0);
      } else {
        expect(result).toEqual({ ok: true });
      }
      await subscription.close();
    });
  });

  it('answers a ring that is half possible per item: only the impossible ones fail', async () => {
    await using(async ({ transport, settle }) => {
      const max = transport.capabilities.maxDeliverDelayMs;
      // With a finite window an item can be impossible by itself. Without one (memory, local) none is,
      // so the broker is made to refuse one: the SDK must treat that batch the same way.
      const finite = Number.isFinite(max);
      const faulty = new FaultyTransport(transport);
      if (!finite) faulty.failItems((item) => item.bell.jobId === 'b', 'rejected');
      const { seen, subscription } = collect(faulty, 'q', 5);
      const results = await faulty.ring([
        { bell: bell('q', 'a') },
        finite ? { bell: bell('q', 'b'), deliverAfterMs: max + 1 } : { bell: bell('q', 'b') },
        { bell: bell('q', 'c') },
      ]);
      expect(results).toEqual([
        { ok: true },
        { ok: false, reason: finite ? 'delay-too-long' : 'rejected' },
        { ok: true },
      ]);
      await until(async () => {
        await settle();
        return seen.length >= 2;
      }, 'the two bells that were accepted');
      await settle();
      expect(jobIds(seen).toSorted()).toEqual(['a', 'c']);
      await subscription.close();
      faulty.release();
    });
  });
}
