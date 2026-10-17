import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import type { PostgresLocalTransport } from '../src';
import { countingSource, makeTransport, waitFor, worker } from './support';

const bell = (jobId?: string) => ({ namespace: 'test', queue: 'q', ...(jobId && { jobId }) });

describeDb('PostgresLocalTransport on a database', () => {
  let t: TestStore;
  const open: PostgresLocalTransport[] = [];
  const track = (transport: PostgresLocalTransport) => {
    open.push(transport);
    return transport;
  };

  beforeAll(async () => {
    t = await openTestStore({ clock: null });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state`;
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((transport) => transport.close()));
  });

  describe('waking a worker', () => {
    test('a ring reaches a worker through NOTIFY, long before the poll would', async () => {
      const source = countingSource(t);
      const transport = track(makeTransport(t, { source, pollIntervalMs: 10_000 }));
      const done: string[] = [];
      transport.subscribe('q', worker(t, done), { capacity: () => 5 });
      await transport.ready();
      await waitFor(() => source.probes === 1, 'the first poll turn');
      const ids = await enqueueN(t.store, 3);
      const started = Date.now();
      await transport.ring(ids.map((id) => ({ bell: bell(id) })));
      await waitFor(() => done.length === 3, 'three jobs completed');
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(source.probes).toBe(1);
      expect(transport.mode).toBe('listen');
    });

    test('with no bell at all, the poll finds the work', async () => {
      const done: string[] = [];
      const seen: Delivery[] = [];
      const transport = track(makeTransport(t));
      transport.subscribe('q', worker(t, done, seen), { capacity: () => 5 });
      const ids = await enqueueN(t.store, 2);
      await waitFor(() => done.length === 2, 'two jobs completed');
      expect(done.toSorted()).toEqual(ids.toSorted());
      expect(seen.every((delivery) => delivery.bell?.jobId === undefined)).toBe(true);
    });

    test('a worker with no room makes no claim attempt, and gets one when room returns', async () => {
      const source = countingSource(t);
      const transport = track(makeTransport(t, { source }));
      const done: string[] = [];
      let room = 0;
      const sub = transport.subscribe('q', worker(t, done), { capacity: () => room });
      await transport.ready();
      const [id] = await enqueueN(t.store, 1);
      await transport.ring([{ bell: bell(id) }]);
      await Bun.sleep(300);
      expect(source.probes).toBe(0);
      expect(done).toEqual([]);
      room = 1;
      sub.refresh();
      await waitFor(() => done.length === 1, 'the job completed');
    });

    test('more jobs than the bell cap hold are all found, the poll covers the dropped bells', async () => {
      const transport = track(makeTransport(t, { maxBufferedBells: 3 }));
      const done: string[] = [];
      const seen: Delivery[] = [];
      let room = 0;
      const sub = transport.subscribe('q', worker(t, done, seen), { capacity: () => room });
      await transport.ready();
      const ids = await enqueueN(t.store, 20);
      await transport.ring(ids.map((id) => ({ bell: bell(id) })));
      await Bun.sleep(150);
      room = 1;
      sub.refresh();
      await waitFor(() => done.length === 20, 'twenty jobs completed', 10_000);
      expect(new Set(done).size).toBe(20);
      // At most the three held bells carried a job id: the rest were rung by the poll.
      expect(
        seen.filter((delivery) => delivery.bell?.jobId !== undefined).length
      ).toBeLessThanOrEqual(3);
    });

    test('the poll stays quiet while a bell is being handled', async () => {
      const source = countingSource(t);
      const transport = track(makeTransport(t, { source }));
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      transport.subscribe(
        'q',
        async (delivery) => {
          started += 1;
          await held;
          await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ready();
      const [id] = await enqueueN(t.store, 1);
      await transport.ring([{ bell: bell(id) }]);
      await waitFor(() => started === 1, 'the handler to start');
      const probes = source.probes;
      await Bun.sleep(250);
      expect(source.probes).toBe(probes);
      release();
    });

    test('a delayed bell is held at the listener until its delay has passed', async () => {
      const transport = track(makeTransport(t));
      const seen: Delivery[] = [];
      transport.subscribe(
        'q',
        async (delivery) => {
          seen.push(delivery);
          await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ready();
      const started = Date.now();
      await transport.ring([{ bell: bell('later'), deliverAfterMs: 400 }]);
      await Bun.sleep(300);
      expect(seen).toEqual([]);
      await waitFor(() => seen.length === 1, 'the delayed bell');
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(400);
      expect(waited).toBeLessThan(400 + 20 * 25);
    });

    test('a bell nobody settles comes back after the visibility timeout', async () => {
      const transport = track(makeTransport(t, { visibilityTimeoutMs: 200 }));
      let calls = 0;
      transport.subscribe(
        'q',
        async (delivery) => {
          calls += 1;
          if (calls > 1) await delivery.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ready();
      await transport.ring([{ bell: bell('x') }]);
      await waitFor(() => calls === 1, 'the first delivery');
      await Bun.sleep(100);
      expect(calls).toBe(1);
      await waitFor(() => calls === 2, 'the redelivery');
    });
  });
});
