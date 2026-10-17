import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { JobOptions } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import { Lines } from '../../../test/support/doorbell/lines';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describeSqs, uniqueNamespace, waitFor } from './support';
import type { WorkerHooks } from './testWorker';

const NAMESPACE = uniqueNamespace();
const CRASHER = `${import.meta.dir}/crashingWorker.ts`;

/** Recovering a dead worker's lease spends an attempt: the job needs one more to run again. */
const RETRIES: JobOptions = { attempts: 3, backoff: 500 };

interface Lease {
  id: string;
  token: string;
}

/**
 * The crash and slow-worker scenarios of spike 04 (2c, 2d), now against `PostgresStore` and
 * `SqsTransport` on the SQS emulator. A bell wakes a worker; only the lease protects a job, and
 * only the tick recovers a job whose worker died after its claim. The queues' visibility timeout is
 * 3 s (`FAST_QUEUE`).
 *
 * Every result here is an "emulator" result: ElasticMQ, not Amazon SQS.
 */
describeDb('doorbell on SQS: crashes and slow workers', () => {
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
    const invariants = (s: Scenario, ids: string[], attempts?: (id: string) => number) =>
      checkInvariants(t.fresh.sql, NAMESPACE, s.ledger, ids, attempts ? { attempts } : {});

    /**
     * Rings one job, lets a separate process claim it and hang at `mode`, then SIGKILLs it. The
     * crasher's claim and run go into the scenario ledger, as any worker's would.
     */
    const crashAfterClaim = async (
      s: Scenario,
      queue: string,
      mode: 'before-ack' | 'after-ack'
    ) => {
      const { ids } = await s.enqueue(queue, 1, s.transport, RETRIES);
      const child = Bun.spawn(['bun', CRASHER, t.fresh.name, NAMESPACE, queue, mode, '3000'], {
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const lines = new Lines(child.stdout);
      const lease = JSON.parse(await lines.next('the crasher claims')) as Lease;
      const start = Date.now();
      s.ledger.claimed(lease.id, 'crasher', lease.token);
      if (mode === 'after-ack') expect(await lines.next('the crasher acks')).toBe('acked');
      child.kill('SIGKILL');
      await child.exited;
      s.ledger.ran(lease.id, 'crasher', start);
      expect(lease.id).toBe(ids[0]!);
      return lease;
    };

    /** The stale token must not settle the job, whether its lease expired or was replaced. */
    const staleComplete = async (s: Scenario, lease: Lease) => {
      const startedAt = Date.now();
      const { ok } = await s.store.complete(
        { jobId: lease.id, token: lease.token, owner: 'crasher' },
        'stale'
      );
      s.ledger.settled(lease.id, 'crasher', lease.token, ok, startedAt);
      expect(ok).toBe(false);
    };

    const jobState = async (id: string) => (await scenario!.states([id]))[0];

    /**
     * Lease expiry is on the database clock. The lease is read again on every poll, in the same
     * statement as the clock: a heartbeat the dead worker sent just before the kill may still land.
     */
    const waitForLeaseExpiry = async (id: string) => {
      expect(await jobState(id)).toBe('active');
      await waitFor(
        async () => {
          const [row] = await t.fresh.sql<Array<{ expired: boolean }>>`
            SELECT lease_until < (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS expired
            FROM qcloud_jobs WHERE namespace = ${NAMESPACE} AND id = ${id}`;
          return row?.expired === true;
        },
        'the crasher lease to expire',
        15_000
      );
    };

    /** The tick: recover the expired lease once, then ring until the retry backoff has passed. */
    const tickUntilCompleted = async (s: Scenario, ids: string[]) => {
      expect(await s.tick({ reRingAfterMs: 0 })).toMatchObject({ recovered: 1 });
      await untilCompleted(s, ids, 20_000, { every: 300, budget: { reRingAfterMs: 1_000 } });
    };

    test('2c crash after the delete: the bell is gone, the tick recovers the lease', async () => {
      const s = await open('q-crash-after-ack');
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const lease = await crashAfterClaim(s, 'q-crash-after-ack', 'after-ack');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-crash-after-ack'],
        concurrency: 1,
        leaseMs: 30_000,
        process: () => gate,
      });

      await waitForLeaseExpiry(lease.id);
      // The bell was deleted before the crash: no redelivery, and a claim would not recover the
      // expired lease anyway. Only the tick does.
      expect(worker.stats.received).toBe(0);
      await staleComplete(s, lease);

      const ids = [lease.id];
      expect(await s.tick({ reRingAfterMs: 0 })).toMatchObject({ recovered: 1 });
      await waitFor(
        async () => {
          await s.tick({ reRingAfterMs: 1_000 });
          return worker.stats.claimed === 1;
        },
        'w1 to claim the recovered job',
        15_000,
        300
      );
      // Active again under w1's token: the crasher's token stays rejected.
      await staleComplete(s, lease);
      release();
      await untilCompleted(s, ids, 15_000);

      expect(await invariants(s, ids, () => 1)).toEqual([]);
      expect(worker.stats).toMatchObject({ redelivered: 0, emptyClaims: 0 });
      expect(await s.deadLettered()).toBe(0);
    }, 60_000);

    test('2c crash before the delete: the bell returns, claims nothing, the tick recovers', async () => {
      const s = await open('q-crash-before-ack');
      const lease = await crashAfterClaim(s, 'q-crash-before-ack', 'before-ack');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-crash-before-ack'],
        concurrency: 1,
        leaseMs: 30_000,
      });

      // The crasher's heartbeat died with it, so the bell is visible again after at most one
      // visibility timeout (3 s). The job is still active under the crasher's lease: the claim
      // skips it, and the bell is deleted.
      await waitFor(() => worker.stats.emptyClaims === 1, 'the bell to be redelivered', 30_000);
      expect(worker.stats.redelivered).toBe(1);
      expect(await jobState(lease.id)).toBe('active');
      await waitForLeaseExpiry(lease.id);
      await staleComplete(s, lease);

      const ids = [lease.id];
      await tickUntilCompleted(s, ids);
      expect(await invariants(s, ids, () => 1)).toEqual([]);
      expect(worker.stats).toMatchObject({ claimed: 1, emptyClaims: 1 });
      expect(await s.deadLettered()).toBe(0);
    }, 70_000);

    test('2d slow worker past the visibility timeout, no heartbeat: the redelivery is harmless', async () => {
      const s = await open('q-slow-before-claim', 'q-slow-after-claim');
      const stall = 5_000;
      const stalled = new Set<string>();
      const once = async (key: string) => {
        if (stalled.has(key)) return;
        stalled.add(key);
        await Bun.sleep(stall);
      };
      // Worker A never extends the visibility timeout (3 s), so a 5 s stall outlives it: once
      // before a claim, once between a successful claim and its delete.
      const hooks: WorkerHooks = {
        async beforeClaim(bell) {
          if (bell.queue === 'q-slow-before-claim') await once(bell.queue);
        },
        async beforeAck(claimed, bell) {
          if (bell.queue === 'q-slow-after-claim' && claimed.length > 0) await once(bell.queue);
        },
      };
      const queues = ['q-slow-before-claim', 'q-slow-after-claim'];
      const a = s.worker({
        owner: 'a',
        queues,
        concurrency: 2,
        leaseMs: 30_000,
        hooks,
        heartbeat: false,
      });
      const before = await s.enqueue('q-slow-before-claim', 1);
      const after = await s.enqueue('q-slow-after-claim', 1);
      await waitFor(() => a.stats.received === 2, 'A to hold both bells', 15_000);
      const b = s.worker({ owner: 'b', queues, concurrency: 4, leaseMs: 30_000 });

      const ids = [...before.ids, ...after.ids];
      const total = (key: 'redelivered' | 'emptyClaims' | 'claimed' | 'claims') =>
        a.stats[key] + b.stats[key];
      await untilCompleted(s, ids, 30_000);
      // Let every copy make its claim attempt, A's late ones included.
      await waitFor(() => total('claims') >= 4, 'every copy of a bell to claim', 20_000);
      expect(total('redelivered')).toBe(2);
      expect(total('emptyClaims')).toBe(2);
      expect(total('claimed')).toBe(2);
      expect(await invariants(s, ids)).toEqual([]);
      expect(await s.deadLettered()).toBe(0);
    }, 60_000);

    test('2d slow worker with the heartbeat: no redelivery however long the claim takes', async () => {
      const s = await open('q-held');
      // A 7 s stall is more than twice the 3 s visibility timeout: ChangeMessageVisibility keeps
      // the bell hidden for as long as the handler runs.
      const hooks: WorkerHooks = { beforeClaim: () => Bun.sleep(7_000) };
      const a = s.worker({
        owner: 'a',
        queues: ['q-held'],
        concurrency: 1,
        leaseMs: 30_000,
        hooks,
      });
      const { ids } = await s.enqueue('q-held', 1);
      await untilCompleted(s, ids, 20_000);
      expect(a.stats).toMatchObject({ received: 1, redelivered: 0, claimed: 1 });
      expect(a.transport.metrics.heartbeats).toBeGreaterThanOrEqual(4);
      expect(await invariants(s, ids)).toEqual([]);
      expect(await s.deadLettered()).toBe(0);
    }, 40_000);
  });
});
