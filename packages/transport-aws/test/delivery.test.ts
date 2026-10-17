import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import type { Ringer } from '../../../test/support/doorbell/ringing';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describeSqs, uniqueNamespace, waitFor } from './support';

const NAMESPACE = uniqueNamespace();

/**
 * The doorbell fault scenarios of spike 04 (2a publish lost, 2b bell delivered twice, 2e paused and
 * rate-limited queues), now against `PostgresStore` and `SqsTransport` on the SQS emulator. Crashes
 * and slow workers are in `crash.test.ts`, delays in `delay.test.ts`, a database outage in
 * `outage.test.ts`.
 *
 * Every result here is an "emulator" result: ElasticMQ, not Amazon SQS (docs/limits.md lists the gaps).
 */
describeDb('doorbell on SQS: delivery faults', () => {
  describeSqs('SQS emulator', () => {
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

    test('baseline: every job is claimed and completed exactly once, bells go out in batches', async () => {
      const s = await open('q-baseline');
      const workers = [1, 2].map((n) =>
        s.worker({ owner: `w${n}`, queues: ['q-baseline'], concurrency: 4, leaseMs: 30_000 })
      );
      const { ids, rung } = await s.enqueue('q-baseline', 50);
      expect(rung).toBe(true);
      // 50 bells are 5 requests of 10, not 50 (the cost line: SendMessageBatch is one request).
      expect(s.transport.metrics.sendCalls).toBe(5);

      // A bell that arrives while `markRung` still holds the job's row finds it locked and the
      // claim is empty (DESIGN.md, invariant 3). ElasticMQ delivers within a millisecond or two, so
      // a burst hits this race. The worker's one recheck after 25 ms is the answer, as in the SDK
      // worker, so no tick runs here: nothing but the bells and the recheck completes the jobs.
      await untilCompleted(s, ids, 20_000);
      expect(await invariants(s, ids)).toEqual([]);
      const stats = workers.map((w) => w.stats);
      expect(stats.reduce((sum, w) => sum + w.claimed, 0)).toBe(50);
      expect(stats.reduce((sum, w) => sum + w.claimErrors, 0)).toBe(0);
      expect(await s.deadLettered()).toBe(0);
      // How often the recheck was needed is a property of the broker's speed, not an assertion.
      console.log(
        `[baseline] emulator ${JSON.stringify({ rechecked: stats.reduce((sum, w) => sum + w.rechecked, 0) })}`
      );
    }, 40_000);

    test('2a ring fails after commit: the jobs stay unrung and the tick rings them', async () => {
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

    test('2a a batch the broker half takes: only the bells it took are marked rung', async () => {
      const s = await open('q-half-rung');
      let call = 0;
      const half: Ringer = {
        ring: async (items) => {
          const results = await s.transport.ring(items);
          call += 1;
          return results.map((result, index) =>
            call === 1 && index % 2 === 1 ? { ok: false, reason: 'rejected' as const } : result
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

    test('2b the same bell delivered twice: the second claim finds nothing and acks', async () => {
      const s = await open('q-duplicate');
      const workers = [1, 2].map((n) =>
        s.worker({ owner: `w${n}`, queues: ['q-duplicate'], concurrency: 2, leaseMs: 30_000 })
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
      // The empty claims were deleted, not left to expire: past the 3 s visibility timeout, and
      // the 3 s heartbeat that would have kept them, nothing comes back.
      await Bun.sleep(4_500);
      expect([sum('received'), sum('redelivered')]).toEqual([40, 0]);
      expect(await s.deadLettered()).toBe(0);
    }, 40_000);

    test('2e paused queue: bells are consumed, and resume lets the tick ring again', async () => {
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

    test('2e rate-limited queue: throttled bells are consumed and re-rung', async () => {
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

    test('a bell for queue A is never delivered to a subscriber of queue B', async () => {
      const s = await open('q-a', 'q-b');
      const b = s.worker({ owner: 'wb', queues: ['q-b'], concurrency: 4, leaseMs: 30_000 });
      const { ids } = await s.enqueue('q-a', 5);
      await Bun.sleep(1_500);
      expect(b.stats.received).toBe(0);
      expect(await s.completed(ids)).toBe(0);

      s.worker({ owner: 'wa', queues: ['q-a'], concurrency: 4, leaseMs: 30_000 });
      await untilCompleted(s, ids, 15_000);
      expect(b.stats.received).toBe(0);
      expect(await invariants(s, ids)).toEqual([]);
    }, 40_000);
  });
});
