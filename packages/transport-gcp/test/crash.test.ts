import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { JobOptions } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { checkInvariants } from '../../../test/support/doorbell/ledger';
import { Lines } from '../../../test/support/doorbell/lines';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { Scenario, untilCompleted } from './scenario';
import { describePubsub, uniqueNamespace, waitFor } from './support';
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
 * The crash and slow-worker scenarios of spike 03, now against `PostgresStore` and
 * `PubSubTransport` on the emulator. A bell wakes a worker; only the lease protects a job, and only
 * the tick recovers a job whose worker died after its claim.
 */
describeDb('doorbell on Pub/Sub: crashes and slow workers', () => {
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

    const jobState = async (id: string) => {
      const [row] = await t.fresh.sql<Array<{ state: string }>>`
        SELECT state FROM qcloud_jobs WHERE namespace = ${NAMESPACE} AND id = ${id}`;
      return { state: row?.state };
    };

    /**
     * Lease expiry is on the database clock. The lease is read again on every poll, in the same
     * statement as the clock: a heartbeat the dead worker sent just before the kill may still land.
     */
    const waitForLeaseExpiry = async (id: string) => {
      expect((await jobState(id)).state).toBe('active');
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

    test('4c crash after the ack: the bell is gone, the tick recovers the lease', async () => {
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
      // The bell was acked before the crash: no redelivery, and a claim would not recover the
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

    test('4c crash before the ack: the redelivered bell claims nothing, the tick recovers', async () => {
      const s = await open('q-crash-before-ack');
      const lease = await crashAfterClaim(s, 'q-crash-before-ack', 'before-ack');
      const worker = s.worker({
        owner: 'w1',
        queues: ['q-crash-before-ack'],
        concurrency: 1,
        leaseMs: 30_000,
      });

      // The ack deadline (10 s) expires and the bell comes back, but the job is still active under
      // the crasher's lease: the claim skips it, and the bell is acked.
      await waitFor(() => worker.stats.emptyClaims === 1, 'the bell to be redelivered', 40_000);
      expect(worker.stats.redelivered).toBe(1);
      expect((await jobState(lease.id)).state).toBe('active');
      await waitForLeaseExpiry(lease.id);
      await staleComplete(s, lease);

      const ids = [lease.id];
      await tickUntilCompleted(s, ids);
      expect(await invariants(s, ids, () => 1)).toEqual([]);
      expect(worker.stats).toMatchObject({ claimed: 1, emptyClaims: 1 });
      expect(await s.deadLettered()).toBe(0);
    }, 70_000);

    test('4d slow worker past its ack deadline: the redelivery is harmless', async () => {
      const s = await open('q-slow-before-claim', 'q-slow-after-claim');
      const stall = 15_000;
      const stalled = new Set<string>();
      const once = async (key: string) => {
        if (stalled.has(key)) return;
        stalled.add(key);
        await Bun.sleep(stall);
      };
      // Worker A stops extending ack deadlines after 1 s, so a 15 s stall outlives the 10 s
      // deadline: once before a claim, once between a successful claim and its ack.
      const hooks: WorkerHooks = {
        async beforeClaim(bell) {
          if (bell.queue === 'q-slow-before-claim') await once(bell.queue);
        },
        async beforeAck(claimed, bell) {
          if (bell.queue === 'q-slow-after-claim' && claimed.length > 0) await once(bell.queue);
        },
      };
      const a = s.worker({
        owner: 'a',
        queues: ['q-slow-before-claim', 'q-slow-after-claim'],
        concurrency: 2,
        leaseMs: 30_000,
        hooks,
        maxExtensionMs: 1_000,
      });
      const before = await s.enqueue('q-slow-before-claim', 1);
      const after = await s.enqueue('q-slow-after-claim', 1);
      await waitFor(() => a.stats.received === 2, 'A to hold both bells', 15_000);
      const b = s.worker({
        owner: 'b',
        queues: ['q-slow-before-claim', 'q-slow-after-claim'],
        concurrency: 4,
        leaseMs: 30_000,
      });

      const ids = [...before.ids, ...after.ids];
      const total = (key: 'redelivered' | 'emptyClaims' | 'claimed') => a.stats[key] + b.stats[key];
      await untilCompleted(s, ids, 45_000);
      // A copy may still be waiting for one of A's slots: let every copy make its claim attempt.
      await waitFor(
        () => a.stats.claims >= 2 && total('emptyClaims') >= 2,
        'the late copy of each bell to claim nothing',
        25_000
      );
      expect(total('redelivered')).toBeGreaterThanOrEqual(2);
      expect(total('emptyClaims')).toBeGreaterThanOrEqual(2);
      expect(total('claimed')).toBe(2);
      expect(await invariants(s, ids)).toEqual([]);
      expect(await s.deadLettered()).toBe(0);
    }, 90_000);
  });
});
