import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { routeJobId, StoreError } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import {
  addHook,
  event,
  journal,
  KEY,
  rawDeliveries,
} from '../../store-postgres/test/webhookHelpers';
import { RecordingTransport } from './support';
import { senderHarness, status } from './webhookSending';

describeDb('webhook sender: a queue route adds a job through the tick', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({
      webhookKey: KEY,
      ringWindowMs: 3_600_000,
      poolSize: 8,
      random: () => 0.5,
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state`;
    transport = new RecordingTransport({ clock: t.clock });
  });

  const { sending } = senderHarness(
    () => t,
    () => transport
  );

  /** A queue route from `from` to `to` on `job.pushed`. */
  const route = (from: string, to: string) =>
    addHook(t, {
      destination: 'queue',
      url: undefined,
      queue: from,
      target: to,
      events: ['job.pushed'],
    });
  const jobsIn = async (queue: string) => (await t.store.listJobs({ queue, limit: 50 })).items;

  test('A is pushed, then B is enqueued once, with no request made', async () => {
    const hook = await route('orders', 'refunds');
    await journal(t, [event('pushed', 'orders', 'o-1')]);
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    const jobs = await jobsIn('refunds');
    expect(jobs).toHaveLength(1);
    const [first] = await rawDeliveries(t);
    const deliveryId = first!.id;
    expect(jobs[0]).toMatchObject({
      id: routeJobId(deliveryId),
      name: 'job.pushed',
      data: { event: 'job.pushed', queue: 'orders', jobId: 'o-1' },
    });
    expect(s.seen).toEqual([]);

    const page = await t.store.webhooks.deliveries(hook.id);
    expect(page!.items[0]).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: null,
    });
    expect(page!.items[0]!.history.map((h) => [h.statusCode, h.error])).toEqual([[null, null]]);
    // The tick's next pass finds nothing more to do for it.
    expect((await s.pass()).webhooks.claimed).toBe(0);
    expect(await jobsIn('refunds')).toHaveLength(1);
  });

  test('a crash after the job was added and before the result was recorded makes no second job', async () => {
    await route('orders', 'refunds');
    await journal(t, [event('pushed', 'orders', 'o-1')]);
    const s = sending(() => status(200));
    await s.pass();
    // What the store holds after that crash: the delivery claimed, its job already there.
    await t.fresh
      .sql`UPDATE qcloud_deliveries SET status = 'pending', next_attempt_at = ${t.clock.now()}`;

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await jobsIn('refunds')).toHaveLength(1);
  });

  test('routes feeding routes: A to B to C, one job each', async () => {
    await route('a', 'b');
    await route('b', 'c');
    await journal(t, [event('pushed', 'a', 'j1')]);
    const s = sending(() => status(200));

    await s.pass();
    expect(await jobsIn('b')).toHaveLength(1);
    // The job the first route added is a job like any other: its event matches the second route.
    await s.pass();
    expect(await jobsIn('c')).toHaveLength(1);
    await s.pass();
    expect(await jobsIn('a')).toHaveLength(0);
    expect(await jobsIn('b')).toHaveLength(1);
    expect(await jobsIn('c')).toHaveLength(1);
  });

  test('a refused enqueue is a failed attempt that retries on the webhook schedule, and then succeeds', async () => {
    await route('orders', 'refunds');
    await journal(t, [event('pushed', 'orders', 'o-1')]);
    const refusing = Object.create(t.store, {
      enqueue: {
        value: async () => {
          throw new StoreError('queue is full');
        },
      },
    }) as PostgresStore;

    const broken = sending(() => status(200), {}, refusing);
    expect((await broken.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 0, retrying: 1 });
    expect(await jobsIn('refunds')).toHaveLength(0);
    const [row] = await rawDeliveries(t);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Number(row!.next_attempt_at)).toBe(t.clock.now() + 1_000);

    t.clock.advance(1_000);
    const working = sending(() => status(200));
    expect((await working.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await jobsIn('refunds')).toHaveLength(1);
  });

  test('an http route beside a queue route is sent as before', async () => {
    await addHook(t, { events: ['job.pushed'], queue: 'orders' });
    await route('orders', 'refunds');
    await journal(t, [event('pushed', 'orders', 'o-1')]);
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 2, delivered: 2 });
    expect(s.seen).toHaveLength(1);
    expect(await jobsIn('refunds')).toHaveLength(1);
  });
});
