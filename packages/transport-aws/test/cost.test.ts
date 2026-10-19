import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { billedRequests } from '../src';
import { Scenario, untilCompleted } from './scenario';
import { describeSqs, uniqueNamespace } from './support';

const NAMESPACE = uniqueNamespace();
const JOBS = 100;

/**
 * What one job costs in SQS requests, counted from the transport's own metrics. SQS bills per
 * request (a `SendMessageBatch` of 10 is one), so the per-job figure times the list price is the
 * monthly cost: docs/limits.md ("Cost of the doorbell") has the arithmetic and the price.
 *
 * Every result here is an "emulator" result: ElasticMQ, not Amazon SQS. The counts are the client's,
 * so they carry over; what the emulator cannot say is how often real SQS returns fewer bells than
 * asked for on a long poll (it may, and that only adds receives).
 */
describeDb('doorbell on SQS: request count per job', () => {
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

    /** Runs `JOBS` jobs through one worker of `concurrency` slots, with the tick at its default. */
    async function run(queue: string, concurrency: number) {
      const s = (scenario = await Scenario.open(t, NAMESPACE, [queue]));
      const worker = s.worker({ owner: 'w1', queues: [queue], concurrency, leaseMs: 30_000 });
      const { ids } = await s.enqueue(queue, JOBS);
      await untilCompleted(s, ids, 60_000, { every: 1_000, budget: { reRingAfterMs: 5_000 } });
      expect(await checkInvariants(t.fresh.sql, NAMESPACE, s.ledger, ids)).toEqual([]);
      const producer = s.transport.metrics;
      const consumer = worker.transport.metrics;
      const total = billedRequests(producer) + billedRequests(consumer);
      const line = {
        concurrency,
        sends: producer.sendCalls + consumer.sendCalls,
        receives: consumer.receiveCalls,
        deletes: consumer.deletes,
        deletedBells: consumer.deletedBells,
        heartbeats: consumer.heartbeats,
        nacks: consumer.nacks,
        emptyClaims: worker.stats.emptyClaims,
        requestsPerJob: Math.round((total / JOBS) * 100) / 100,
      };
      console.log(`[cost] emulator ${JSON.stringify(line)}`);
      return { line, producer, consumer };
    }

    test('a worker with room for ten: one send per ten bells, deletes shared by the bells acked together', async () => {
      const { line, producer, consumer } = await run('q-cost-wide', 10);
      // 100 bells are 10 batches of 10, and each is deleted once, in a batch with whatever was acked
      // within a few milliseconds of it.
      expect(producer.sentBells).toBe(JOBS);
      expect(line.sends).toBe(JOBS / 10);
      expect(line.deletedBells).toBe(consumer.received);
      expect(line.deletes).toBeLessThan(line.deletedBells);
      // Slots free one job at a time and a receive asks for what is free, so a busy worker receives
      // about once per bell (the long-poll tail adds a few). Never more than that.
      expect(line.receives).toBeLessThanOrEqual(JOBS + 5);
      expect(line.requestsPerJob).toBeGreaterThanOrEqual(0.8);
      expect(line.requestsPerJob).toBeLessThan(1.6);
      expect(line.nacks).toBe(0);
    }, 90_000);

    test('a worker with one slot takes one bell per receive: the worst case', async () => {
      const { line } = await run('q-cost-narrow', 1);
      // One receive per bell, a delete request for a few bells each and a tenth of a send. Deletes
      // only share a request when acks land within a few milliseconds of each other.
      expect(line.receives).toBeGreaterThanOrEqual(JOBS);
      expect(line.requestsPerJob).toBeGreaterThanOrEqual(1.2);
      expect(line.requestsPerJob).toBeLessThan(2.3);
    }, 90_000);
  });
});
