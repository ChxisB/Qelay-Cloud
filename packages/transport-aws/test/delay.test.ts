import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { RingResult } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import type { Ringer } from '../../../test/support/doorbell/ringing';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describeSqs, uniqueNamespace, waitFor } from './support';

const NAMESPACE = uniqueNamespace();

/** Bells further out than this are rung when a job is written, not left to the tick. */
const RING_WINDOW_MS = 60_000;
/** The database and the emulator share a host, but a container's clock can sit a little off it. */
const CLOCK_SLACK_MS = 250;
/** SQS holds a message for at most 15 minutes. */
const SQS_MAX_DELAY_MS = 900_000;

/**
 * A transport whose broker holds a bell for at most `maxMs`, as SQS does for 900 s. A test that
 * wants to cross that limit would otherwise wait a quarter of an hour.
 */
function limitedTo(inner: Ringer, maxMs: number): Ringer {
  return {
    async ring(items) {
      const results: RingResult[] = items.map(() => ({ ok: false, reason: 'delay-too-long' }));
      const allowed = items.flatMap((item, index) =>
        (item.deliverAfterMs ?? 0) <= maxMs ? [{ item, index }] : []
      );
      const sent = await inner.ring(allowed.map(({ item }) => item));
      allowed.forEach(({ index }, position) => {
        results[index] = sent[position]!;
      });
      return results;
    },
  };
}

/** A job that fails the first time it runs and succeeds after. */
function failOnce() {
  const failed = new Set<string>();
  return async (job: { id: string }) => {
    if (failed.has(job.id)) return;
    failed.add(job.id);
    throw new Error('injected: the first attempt fails');
  };
}

/**
 * Delayed bells on SQS: `DelaySeconds` is whole seconds and at most 900, so the transport rounds a
 * delay up, refuses a longer one (`delay-too-long`, never clamped), and the tick pre-rings a job
 * that is further out as its `run_at` comes inside the window.
 *
 * Every result here is an "emulator" result: ElasticMQ, not Amazon SQS.
 */
describeDb('doorbell on SQS: delayed bells', () => {
  describeSqs('SQS emulator', () => {
    let t: TestStore;
    let scenario: Scenario | undefined;

    beforeAll(async () => {
      t = await openTestStore({ clock: null, namespace: NAMESPACE, ringWindowMs: RING_WINDOW_MS });
    });
    afterEach(async () => {
      await scenario?.close();
      scenario = undefined;
    });
    afterAll(async () => {
      await t?.drop();
    });

    const open = async (...queues: string[]) =>
      (scenario = await Scenario.open(t, NAMESPACE, queues, { ringWindowMs: RING_WINDOW_MS }));
    const invariants = (s: Scenario, ids: string[], attempts?: (id: string) => number) =>
      checkInvariants(t.fresh.sql, NAMESPACE, s.ledger, ids, attempts ? { attempts } : {});
    const claimTimes = (s: Scenario, ids: readonly string[]) =>
      s.ledger.claims.filter((claim) => ids.includes(claim.jobId)).map((claim) => claim.at);

    test('a delayed bell never arrives before run_at: delays are whole seconds, rounded up', async () => {
      const s = await open('q-delay');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-delay'],
        concurrency: 4,
        leaseMs: 30_000,
      });
      // 1500 ms has no SQS spelling: it must go out as 2 s, not 1 s.
      const { ids, rung, rings } = await s.enqueue('q-delay', 3, s.transport, { delay: 1_500 });
      expect([rung, rings]).toEqual([true, 3]);
      await Bun.sleep(1_000);
      expect(worker.stats.received).toBe(0);

      await untilCompleted(s, ids, 10_000);
      const [runAt] = await s.runAt(ids);
      const claimed = claimTimes(s, ids);
      expect(claimed).toHaveLength(3);
      // Claimed at or after run_at (an early bell would be an empty claim and a second ring) and
      // within the rounding second of it.
      expect(Math.min(...claimed)).toBeGreaterThanOrEqual(runAt! - CLOCK_SLACK_MS);
      expect(Math.max(...claimed)).toBeLessThan(runAt! + 1_000 + CLOCK_SLACK_MS + 1_000);
      expect(worker.stats).toMatchObject({ received: 3, claimed: 3, emptyClaims: 0 });
      expect(await invariants(s, ids)).toEqual([]);
    }, 30_000);

    test('SQS holds a bell for at most 900 s: the transport says so, the service agrees', async () => {
      const s = await open('q-limit');
      const bell = { namespace: NAMESPACE, queue: 'q-limit' };
      const max = s.transport.capabilities.maxDeliverDelayMs;
      expect(max).toBe(SQS_MAX_DELAY_MS);
      expect(await s.transport.ring([{ bell, deliverAfterMs: max }])).toEqual([{ ok: true }]);
      expect(
        await s.transport.ring([
          { bell, deliverAfterMs: max + 1 },
          { bell, deliverAfterMs: max + 60_000 },
        ])
      ).toEqual([
        { ok: false, reason: 'delay-too-long' },
        { ok: false, reason: 'delay-too-long' },
      ]);
      // Nothing was sent for the refused bells: the one accepted bell is the only delayed message.
      expect(s.transport.metrics.sentBells).toBe(1);
      await waitFor(
        async () => (await s.transport.stats('q-limit')).delayed === 1,
        'one delayed bell',
        10_000,
        200
      );

      // The service itself, called past the transport's guard.
      const send = (seconds: number) =>
        s.env.client.send(
          new SendMessageCommand({
            QueueUrl: s.env.provisioned('q-limit').queueUrl,
            MessageBody: JSON.stringify(bell),
            DelaySeconds: seconds,
          })
        );
      await expect(send(SQS_MAX_DELAY_MS / 1_000 + 1)).rejects.toThrow();
      await send(SQS_MAX_DELAY_MS / 1_000);
    }, 30_000);

    test('beyond the limit the job is not rung: the tick pre-rings it as run_at comes inside the window', async () => {
      const s = await open('q-defer');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-defer'],
        concurrency: 4,
        leaseMs: 30_000,
      });
      // A 1 s limit stands in for 900 s, so the test does not wait a quarter of an hour.
      const limited = limitedTo(s.transport, 1_000);
      const { ids, rung } = await s.enqueue('q-defer', 3, limited, { delay: 3_000 });
      expect(rung).toBe(false);
      const [runAt] = await s.runAt(ids);
      expect(await s.states(ids)).toEqual(ids.map(() => 'delayed'));
      expect(await s.rungAt(ids)).toEqual(ids.map(() => null));

      // Too early: run_at is 3 s away and the window is the transport's 1 s.
      const budget = { reRingAfterMs: 60_000, ringWindowMs: 1_000 };
      expect(await s.tick(budget, limited)).toEqual({ recovered: 0, rung: 0 });

      // Inside the window: one delayed bell per job, due at run_at, rung once.
      await s.untilDatabaseTime(runAt! - 800);
      expect(await s.tick(budget, limited)).toEqual({ recovered: 0, rung: 3 });
      expect(await s.tick(budget, limited)).toEqual({ recovered: 0, rung: 0 });
      expect((await s.rungAt(ids)).every((at) => at !== null && at >= runAt!)).toBe(true);

      await untilCompleted(s, ids, 10_000);
      expect(Math.min(...claimTimes(s, ids))).toBeGreaterThanOrEqual(runAt! - CLOCK_SLACK_MS);
      expect(worker.stats).toMatchObject({ received: 3, claimed: 3, emptyClaims: 0 });
      expect(await invariants(s, ids)).toEqual([]);
    }, 30_000);

    test('a failed job rings its own retry for run_at: no tick, no early claim', async () => {
      const s = await open('q-retry');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-retry'],
        concurrency: 4,
        leaseMs: 30_000,
        process: failOnce(),
      });
      const { ids } = await s.enqueue('q-retry', 3, s.transport, { attempts: 3, backoff: 1_500 });
      await untilCompleted(s, ids, 15_000);
      expect(worker.stats).toMatchObject({
        failed: 3,
        retriesRung: 3,
        completed: 3,
        emptyClaims: 0,
      });
      expect(await invariants(s, ids, () => 1)).toEqual([]);

      // The second claim of each job waited out its backoff.
      const claimed = claimTimes(s, ids);
      expect(claimed).toHaveLength(6);
      const firsts = claimed.slice(0, 3);
      const seconds = claimed.slice(3);
      expect(Math.min(...seconds) - Math.max(...firsts)).toBeGreaterThanOrEqual(
        1_500 - CLOCK_SLACK_MS
      );
    }, 40_000);

    test('without ringing the retry the job waits for the tick: durable, only late', async () => {
      const s = await open('q-no-retry-ring');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-no-retry-ring'],
        concurrency: 4,
        leaseMs: 30_000,
        process: failOnce(),
        ringRetries: false,
      });
      const { ids } = await s.enqueue('q-no-retry-ring', 2, s.transport, {
        attempts: 3,
        backoff: 500,
      });
      await waitFor(() => worker.stats.failed === 2, 'both jobs to fail once', 10_000);
      await Bun.sleep(1_500);
      expect(await s.states(ids)).toEqual(ids.map(() => 'delayed'));
      expect(worker.stats.retriesRung).toBe(0);

      // The tick's ring query finds them once run_at has passed and the first bell is old enough.
      await untilCompleted(s, ids, 15_000, { every: 300, budget: { reRingAfterMs: 500 } });
      expect(await invariants(s, ids, () => 1)).toEqual([]);
    }, 40_000);
  });
});
