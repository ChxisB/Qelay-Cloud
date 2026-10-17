import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import type { Ringer } from '../../../test/support/doorbell/ringing';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describePubsub, uniqueNamespace, waitFor } from './support';

const NAMESPACE = uniqueNamespace();

/**
 * The doorbell fault scenarios of spike 03 (publish lost, bell delivered twice, paused and
 * rate-limited queues), now against `PostgresStore` and `PubSubTransport` on the emulator. Crashes
 * and slow workers are in `crash.test.ts`.
 */
describeDb('doorbell on Pub/Sub: delivery faults', () => {
  describePubsub('Pub/Sub emulator', () => {
    let t: TestStore;
    let scenario: Scenario | undefined;

    beforeAll(async () => {
      t = await openTestStore({ clock: null, namespace: NAMESPACE });
    });
    afterEach(async () => {
      await scenario?.close();
      scenario = undefined;
    });
    afterAll(async () => {
      await t?.drop();
    });

    const open = async (...queues: string[]) =>
      (scenario = await Scenario.open(t, NAMESPACE, queues));
    const invariants = (s: Scenario, ids: string[]) =>
      checkInvariants(t.fresh.sql, NAMESPACE, s.ledger, ids);

    test('baseline: every job is claimed and completed exactly once', async () => {
      const s = await open('q-baseline');
      const workers = [1, 2].map((n) =>
        s.worker({ owner: `w${n}`, queues: ['q-baseline'], concurrency: 4, leaseMs: 30_000 })
      );
      const { ids, rung } = await s.enqueue('q-baseline', 50);
      expect(rung).toBe(true);
      await untilCompleted(s, ids, 20_000);
      expect(await invariants(s, ids)).toEqual([]);
      const stats = workers.map((w) => w.stats);
      expect(stats.reduce((sum, w) => sum + w.claimed, 0)).toBe(50);
      expect(stats.reduce((sum, w) => sum + w.emptyClaims, 0)).toBe(0);
      expect(await s.deadLettered()).toBe(0);
    }, 40_000);

    test('4a ring fails after commit: the jobs stay unrung and the tick rings them', async () => {
      const s = await open('q-ring-fails');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-ring-fails'],
        concurrency: 4,
        leaseMs: 30_000,
      });
      const failing: Ringer = {
        ring: async (items) => items.map(() => ({ ok: false, reason: 'unreachable' as const })),
      };
      const { ids, rung } = await s.enqueue('q-ring-fails', 5, failing);
      expect(rung).toBe(false);

      // Committed, never rung: durable but asleep until the tick.
      await Bun.sleep(1_000);
      expect(await s.rungAt(ids)).toEqual(ids.map(() => null));
      expect(worker.stats.received).toBe(0);

      // A null rung_at is due at any threshold.
      expect(await s.tick({ reRingAfterMs: 60_000 })).toEqual({ recovered: 0, rung: 5 });
      await untilCompleted(s, ids, 15_000);
      expect(await invariants(s, ids)).toEqual([]);
      expect(worker.stats).toMatchObject({ received: 5, claimed: 5, emptyClaims: 0 });
      expect(await s.tick({ reRingAfterMs: 0 })).toEqual({ recovered: 0, rung: 0 });
    }, 40_000);

    test('4a a batch the broker half takes: only the bells it took are marked rung', async () => {
      const s = await open('q-half-rung');
      let call = 0;
      const half: Ringer = {
        ring: async (items) => {
          const results = await s.transport.ring(items);
          call += 1;
          return results.map((result, index) =>
            call === 1 && index % 2 === 1 ? { ok: false, reason: 'unreachable' as const } : result
          );
        },
      };
      const { ids, rung } = await s.enqueue('q-half-rung', 6, half);
      expect(rung).toBe(false);
      const marks = await s.rungAt(ids);
      expect(marks.map((at) => at !== null)).toEqual([true, false, true, false, true, false]);

      // The three bells that were taken have nobody to hear them yet; the tick finds the other three.
      expect(await s.tick({ reRingAfterMs: 60_000 })).toEqual({ recovered: 0, rung: 3 });
      s.worker({ owner: 'w1', queues: ['q-half-rung'], concurrency: 6, leaseMs: 30_000 });
      await untilCompleted(s, ids, 15_000);
      expect(await invariants(s, ids)).toEqual([]);
    }, 40_000);

    test('4b the same bell delivered twice: the second claim finds nothing and acks', async () => {
      const s = await open('q-duplicate');
      // The client stops extending a held bell after 1 s, so a bell left un-acked would come back
      // after the 10 s ack deadline: the check below that nothing does is meaningful.
      const workers = [1, 2].map((n) =>
        s.worker({
          owner: `w${n}`,
          queues: ['q-duplicate'],
          concurrency: 2,
          leaseMs: 30_000,
          maxExtensionMs: 1_000,
        })
      );
      const twice: Ringer = {
        ring: async (items) =>
          (await s.transport.ring([...items, ...items])).slice(0, items.length),
      };
      const { ids } = await s.enqueue('q-duplicate', 20, twice);
      const sum = (key: 'received' | 'redelivered' | 'claims' | 'claimed' | 'emptyClaims') =>
        workers.reduce((acc, w) => acc + w.stats[key], 0);
      await waitFor(
        async () => (await s.allCompleted(ids)) && sum('claims') === 40,
        'all 20 jobs complete and all 40 bells claimed against',
        20_000
      );
      // Every bell is one claim attempt; each job is claimed by exactly one of them.
      expect([sum('claims'), sum('claimed'), sum('emptyClaims')]).toEqual([40, 20, 20]);
      expect(await invariants(s, ids)).toEqual([]);
      // The empty claims were acked, not left to expire: past the deadline, nothing comes back.
      await Bun.sleep(11_000);
      expect([sum('received'), sum('redelivered')]).toEqual([40, 0]);
      expect(await s.deadLettered()).toBe(0);
    }, 40_000);

    test('4e paused queue: bells are consumed, and resume lets the tick ring again', async () => {
      const s = await open('q-paused');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-paused'],
        concurrency: 4,
        leaseMs: 30_000,
      });
      await s.store.pause('q-paused');
      const { ids } = await s.enqueue('q-paused', 3);
      await waitFor(() => worker.stats.emptyClaims === 3, '3 bells consumed', 15_000);
      expect(worker.stats.claimed).toBe(0);

      // A paused queue is never re-rung, however old the bell.
      expect(await s.tick({ reRingAfterMs: 0 })).toEqual({ recovered: 0, rung: 0 });
      await s.store.resume('q-paused');

      // Resume clears the bell marks, so the very next tick rings, with no wait for the threshold.
      expect(await s.tick({ reRingAfterMs: 60_000 })).toEqual({ recovered: 0, rung: 3 });
      await untilCompleted(s, ids, 15_000);
      expect(await invariants(s, ids)).toEqual([]);
      expect(worker.stats).toMatchObject({ received: 6, claimed: 3, emptyClaims: 3 });
    }, 40_000);

    test('4e rate-limited queue: throttled bells are consumed and re-rung', async () => {
      const s = await open('q-rate-limited');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-rate-limited'],
        concurrency: 6,
        leaseMs: 30_000,
      });
      await s.store.setRateLimit('q-rate-limited', { max: 2, durationMs: 1_000 });
      const { ids } = await s.enqueue('q-rate-limited', 6);
      await waitFor(() => worker.stats.claims === 6, '6 bells consumed', 15_000);
      expect([worker.stats.claimed, worker.stats.emptyClaims]).toEqual([2, 4]);

      // The tick, every 300 ms: ring anything claimable whose bell is 500 ms old.
      const rings = await untilCompleted(s, ids, 20_000, {
        every: 300,
        budget: { reRingAfterMs: 500 },
      });
      expect(await invariants(s, ids)).toEqual([]);
      expect(rings).toBeGreaterThanOrEqual(4);
      // Never more than 2 claims in any 1 s window (200 ms slack for client-side timestamps).
      const times = s.ledger.claims.map((claim) => claim.at).sort((a, b) => a - b);
      for (let index = 2; index < times.length; index++) {
        expect(times[index]! - times[index - 2]!).toBeGreaterThan(800);
      }
    }, 40_000);
  });
});
