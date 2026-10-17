import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describeSqs, uniqueNamespace, waitFor } from './support';

const NAMESPACE = uniqueNamespace();

/**
 * A database outage as the worker sees it: the claim throws, the bell is nacked, and what happens
 * next depends on how long the nack holds it away. The receive count of a bell only ever goes up,
 * so a worker that nacks at once spends the queue's `maxReceiveCount` in a few hundred milliseconds
 * and the bell dead-letters; one that backs off keeps it. Either way nothing is lost, because the
 * bell is only a doorbell: the tick rings a claimable job again, and a dead-lettered bell is a
 * metric, never replayed.
 *
 * Every result here is an "emulator" result: ElasticMQ, not Amazon SQS.
 */
describeDb('doorbell on SQS: database outage', () => {
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

    const invariants = (s: Scenario, ids: string[]) =>
      checkInvariants(t.fresh.sql, NAMESPACE, s.ledger, ids);

    test('a database error nacks with a backoff: no storm, no dead letter, no tick needed', async () => {
      const s = (scenario = await Scenario.open(t, NAMESPACE, ['q-outage']));
      let databaseDown = true;
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-outage'],
        concurrency: 4,
        leaseMs: 30_000,
        hooks: {
          async beforeClaim() {
            if (databaseDown) throw new Error('injected: the database is unreachable');
          },
        },
      });
      const { ids } = await s.enqueue('q-outage', 3);
      await Bun.sleep(2_600);
      // Three bells, each tried once and then held for a second: at most three tries each in 2.6 s.
      expect(worker.stats.claimErrors).toBeGreaterThanOrEqual(3);
      expect(worker.stats.claimErrors).toBeLessThanOrEqual(9);
      expect(worker.stats.claims).toBe(0);
      expect(await s.deadLettered()).toBe(0);

      // The database is back: the held bells return on their own.
      databaseDown = false;
      await untilCompleted(s, ids, 20_000);
      expect(worker.stats.redelivered).toBeGreaterThanOrEqual(3);
      expect(worker.stats.claimed).toBe(3);
      expect(await invariants(s, ids)).toEqual([]);
      expect(await s.deadLettered()).toBe(0);
    }, 40_000);

    test('without a backoff the bells dead-letter, and the tick rings the jobs again', async () => {
      const s = (scenario = await Scenario.open(t, NAMESPACE, ['q-storm'], {
        queue: { maxReceiveCount: 3 },
      }));
      let databaseDown = true;
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-storm'],
        concurrency: 4,
        leaseMs: 30_000,
        claimErrorRetryMs: 0,
        hooks: {
          async beforeClaim() {
            if (databaseDown) throw new Error('injected: the database is unreachable');
          },
        },
      });
      const { ids } = await s.enqueue('q-storm', 4);

      // Every receive is a failed claim and an immediate nack: three each, then the dead-letter queue.
      await waitFor(
        async () => (await s.deadLettered()) === 4,
        'all 4 bells dead-lettered',
        20_000
      );
      expect(worker.stats.claimErrors).toBe(12);
      expect(worker.stats.claims).toBe(0);
      // The dead-letter depth is a metric (stats may be a few seconds old, so it is polled).
      await waitFor(
        async () => (await s.transport.stats('q-storm')).deadLetterDepth === 4,
        'the dead-letter depth in stats',
        20_000,
        500
      );

      // The database is back. No bell is left, but the jobs are claimable and the tick rings them.
      databaseDown = false;
      expect(await s.states(ids)).toEqual(ids.map(() => 'waiting'));
      expect(await s.tick({ reRingAfterMs: 0 })).toEqual({ recovered: 0, rung: 4 });
      await untilCompleted(s, ids, 20_000);
      expect(await invariants(s, ids)).toEqual([]);
      // The dead letters stay where they are: they are alerted on, not replayed.
      expect(await s.deadLettered()).toBe(4);
    }, 60_000);
  });
});
