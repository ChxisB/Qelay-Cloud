import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import type { LocalDatabase } from '../src';
import { PostgresLocalTransport } from '../src';
import { makeTransport, waitFor, worker, wrapDatabase } from './support';

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

  describe('which bells a transport acts on', () => {
    test('a bell of another namespace, or not a bell at all, is ignored', async () => {
      const channel = 'qcloud_t_ignored';
      const transport = track(makeTransport(t, { channel }));
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
      for (const payload of ['{"n":"other","q":"q"}', 'not json', '{"x":1}', '[]']) {
        await t.fresh.sql`SELECT pg_notify(${channel}, ${payload})`;
      }
      await Bun.sleep(200);
      expect(seen).toEqual([]);
      await t.fresh.sql`SELECT pg_notify(${channel}, '{"n":"test","q":"q","j":"mine"}')`;
      await waitFor(() => seen.length === 1, 'the bell of this namespace');
      expect(seen[0]?.bell).toEqual(bell('mine'));
    });

    test('a bell reaches the transport that serves its queue and no other', async () => {
      const channel = 'qcloud_t_two_ways';
      const a = track(makeTransport(t, { channel }));
      const b = track(makeTransport(t, { channel }));
      const seenA: Delivery[] = [];
      const seenB: Delivery[] = [];
      const take = (into: Delivery[]) => async (delivery: Delivery) => {
        into.push(delivery);
        await delivery.ack();
      };
      a.subscribe('q', take(seenA), { capacity: () => 5 });
      b.subscribe('other', take(seenB), { capacity: () => 5 });
      await Promise.all([a.ready(), b.ready()]);
      await b.ring([{ bell: bell('for-a') }]);
      await waitFor(() => seenA.length === 1, 'the bell at the serving transport');
      await Bun.sleep(100);
      expect(seenB).toEqual([]);
    });
  });

  describe('ring', () => {
    test('reports each item of a half-failed batch', async () => {
      const transport = track(makeTransport(t));
      const seen: Delivery[] = [];
      transport.subscribe(
        'q',
        async (delivery) => {
          seen.push(delivery);
          await delivery.ack();
        },
        { capacity: () => 50 }
      );
      await transport.ready();
      const results = await transport.ring([
        { bell: bell('fine') },
        { bell: { namespace: 'elsewhere', queue: 'q' } },
        { bell: bell('nan'), deliverAfterMs: Number.NaN },
        { bell: { namespace: 'test', queue: 'q'.repeat(9_000) } },
        { bell: bell('x'.repeat(9_000)) },
      ]);
      expect(results).toEqual([
        { ok: true },
        { ok: false, reason: 'rejected' },
        { ok: false, reason: 'rejected' },
        { ok: false, reason: 'rejected' },
        { ok: true },
      ]);
      await waitFor(() => seen.length === 2, 'the two accepted bells');
      const byId = seen.map((delivery) => delivery.bell?.jobId);
      expect(byId).toContain('fine');
      expect(byId).toContain(undefined);
    });

    test('says unreachable for what it could not send, and still rejects what could never be sent', async () => {
      const down = wrapDatabase(t.fresh.db, {
        run: async () => {
          throw new Error('connection refused');
        },
      });
      const transport = track(makeTransport(t, { db: down }));
      expect(
        await transport.ring([
          { bell: bell('a') },
          { bell: { namespace: 'elsewhere', queue: 'q' } },
          { bell: bell('b') },
        ])
      ).toEqual([
        { ok: false, reason: 'unreachable' },
        { ok: false, reason: 'rejected' },
        { ok: false, reason: 'unreachable' },
      ]);
    });

    test('an empty batch is an empty result and sends nothing', async () => {
      const transport = track(makeTransport(t));
      expect(await transport.ring([])).toEqual([]);
    });

    test('a bell is never delivered earlier than its delay, for a delay of years too', async () => {
      const transport = track(makeTransport(t));
      expect(transport.capabilities.maxDeliverDelayMs).toBe(Number.POSITIVE_INFINITY);
      const year = 365 * 24 * 60 * 60 * 1000;
      expect(await transport.ring([{ bell: bell('far'), deliverAfterMs: year }])).toEqual([
        { ok: true },
      ]);
    });
  });

  describe('without a LISTEN connection', () => {
    test('runs on the poll loop alone and says so', async () => {
      const pooled = wrapDatabase(t.fresh.db, {
        openListener: () => {
          throw new Error('pooled connection and no listenUrl');
        },
      });
      const transport = track(makeTransport(t, { db: pooled }));
      const done: string[] = [];
      transport.subscribe('q', worker(t, done), { capacity: () => 5 });
      await transport.ready();
      expect(transport.mode).toBe('poll');
      expect(transport.listening).toBe(false);
      expect(transport.pollOnlyReason).toContain('no listenUrl');
      await enqueueN(t.store, 2);
      await waitFor(() => done.length === 2, 'two jobs found by the poll');
    });

    test('a process that only rings never opens a LISTEN connection', async () => {
      const transport = track(makeTransport(t));
      await transport.ring([{ bell: bell('a') }]);
      expect(transport.listening).toBe(false);
      expect(transport.mode).toBe('poll');
    });
  });

  describe('stats and lifecycle', () => {
    test('stats are the store’s counts, fresh and labelled as such', async () => {
      const transport = track(makeTransport(t));
      await enqueueN(t.store, 3);
      await enqueueN(t.store, 2, { delay: 60_000 });
      await t.store.claim('q', 'w', 1);
      const stats = await transport.stats('q');
      expect(stats).toMatchObject({
        depth: 2,
        inFlight: 1,
        delayed: 2,
        deadLetterDepth: 0,
        source: 'postgres-counts',
        maxStalenessMs: 0,
      });
      expect(stats.oldestAgeMs).toBeGreaterThanOrEqual(0);
      expect(Math.abs(stats.observedAt - Date.now())).toBeLessThan(5_000);
    });

    test('after close, ring reports unreachable, subscribe is inert and close is repeatable', async () => {
      const transport = makeTransport(t);
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
      await transport.close();
      await transport.close();
      expect(await transport.ring([{ bell: bell('late') }])).toEqual([
        { ok: false, reason: 'unreachable' },
      ]);
      const late = transport.subscribe('q', async () => {}, { capacity: () => 5 });
      late.refresh();
      await late.close();
      await Bun.sleep(100);
      expect(seen).toEqual([]);
    });

    test('closing one subscription leaves the others of the transport running', async () => {
      const transport = track(makeTransport(t));
      const done: string[] = [];
      const first = transport.subscribe('q', worker(t, done), { capacity: () => 5 });
      transport.subscribe('q', worker(t, done), { capacity: () => 5 });
      await first.close();
      await enqueueN(t.store, 1);
      await waitFor(() => done.length === 1, 'the job through the second subscription');
    });
  });
});

describe('PostgresLocalTransport options', () => {
  test('retry granularity is the poll interval, and a bell carries no attempt count', () => {
    // No database is touched until a subscription is made.
    const transport = makeTransportWithoutDatabase(250);
    expect(transport.capabilities).toEqual({
      maxDeliverDelayMs: Number.POSITIVE_INFINITY,
      maxRingBatch: 1_000,
      attemptCount: 'none',
      retryGranularityMs: 250,
    });
  });
});

function makeTransportWithoutDatabase(pollIntervalMs: number) {
  const unused: LocalDatabase = {
    run: async () => {
      throw new Error('not used');
    },
    openListener: () => {
      throw new Error('not used');
    },
  };
  return new PostgresLocalTransport({
    db: unused,
    source: {
      hasClaimable: async () => false,
      snapshot: async () => {
        throw new Error('not used');
      },
    },
    namespace: 'test',
    pollIntervalMs,
  });
}
