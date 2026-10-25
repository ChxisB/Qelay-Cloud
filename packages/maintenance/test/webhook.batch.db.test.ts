import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { verifyWebhookSignature, WEBHOOK_BATCH_EVENT, WEBHOOK_HEADERS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import { addRoute, addSource, post } from '../../store-postgres/test/inboundHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { KEY } from '../../store-postgres/test/webhookHelpers';
import { noTelemetry } from '../src/telemetry';
import { resolveWebhookConfig } from '../src/webhookConfig';
import { pooledSending, runWebhookLoop } from '../src/webhookLoop';
import { RecordingTransport } from './support';
import { PUBLIC, senderHarness, status, STRICT } from './webhookSending';
import { listener } from './webhookSockets';

const BATCH = { maxEvents: 100, maxBytes: 262_144 };

describeDb('webhook sender: a batch route sends its due deliveries as one request (D15)', () => {
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

  test('three requests are one signed POST with the envelope, and a 2xx delivers all three', async () => {
    const source = await addSource(t);
    const route = await addRoute(t, source.id, { batch: BATCH });
    for (let n = 1; n <= 3; n += 1) await t.store.sources.accept(source.id, post({ n }));
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 3, delivered: 3, failed: 0 });
    expect(s.seen).toHaveLength(1);
    const { headers, body } = s.seen[0]!.request;
    const envelope = JSON.parse(body) as {
      batchId: string;
      count: number;
      events: Array<{ id: string; receivedAt: number; body: { n: number } }>;
    };
    expect(headers[WEBHOOK_HEADERS.event]).toBe(WEBHOOK_BATCH_EVENT);
    expect(headers[WEBHOOK_HEADERS.id]).toBe(envelope.batchId);
    expect(envelope).toMatchObject({ count: 3 });
    expect(envelope.events.map((event) => event.body)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(
      await verifyWebhookSignature({
        secret: route.secret!,
        timestamp: headers[WEBHOOK_HEADERS.timestamp]!,
        body,
        signature: headers[WEBHOOK_HEADERS.signature]!,
        now: Number(headers[WEBHOOK_HEADERS.timestamp]),
      })
    ).toBe(true);

    const items = (await t.store.webhooks.deliveries(route.id))!.items;
    expect(items.every((item) => item.status === 'delivered')).toBe(true);
    expect(items.every((item) => item.batchId === envelope.batchId)).toBe(true);
    expect(items.map((item) => item.id).sort()).toEqual(
      envelope.events.map((event) => event.id).sort()
    );
  });

  test('the same members make the same batch id on the retry, at the same time', async () => {
    const source = await addSource(t);
    const route = await addRoute(t, source.id, { batch: BATCH });
    for (let n = 1; n <= 3; n += 1) await t.store.sources.accept(source.id, post({ n }));
    const s = sending((call) => status(call === 1 ? 503 : 200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 3, delivered: 0, retrying: 3 });
    const failed = (await t.store.webhooks.deliveries(route.id))!.items;
    expect(new Set(failed.map((item) => item.nextAttemptAt)).size).toBe(1);
    expect(failed.every((item) => item.history[0]?.batchId === s.seen[0]!.deliveryId)).toBe(true);

    t.clock.advance(1_000);
    expect((await s.pass()).webhooks).toMatchObject({ claimed: 3, delivered: 3 });
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1]!.deliveryId).toBe(s.seen[0]!.deliveryId);
    expect(s.seen[1]!.attempt).toBe(2);
    expect(s.seen[1]!.request.body).toContain('"count":3');
  });

  test('a plain route of the same source still gets one request for each delivery', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { batch: BATCH });
    await addRoute(t, source.id, { url: 'https://other.example.com/in' });
    for (let n = 1; n <= 2; n += 1) await t.store.sources.accept(source.id, post({ n }));
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 4, delivered: 4 });
    const events = s.seen.map((seen) => seen.request.headers[WEBHOOK_HEADERS.event]);
    expect(events.filter((event) => event === WEBHOOK_BATCH_EVENT)).toHaveLength(1);
    expect(events.filter((event) => event === 'request.received')).toHaveLength(2);
  });

  test('a member whose request was removed fails alone and the rest still go together', async () => {
    const source = await addSource(t);
    const route = await addRoute(t, source.id, { batch: BATCH });
    for (let n = 1; n <= 3; n += 1) await t.store.sources.accept(source.id, post({ n }));
    await t.fresh.sql`DELETE FROM qcloud_requests WHERE id = (SELECT min(id) FROM qcloud_requests)`;
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 3, delivered: 2, retrying: 1 });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.request.body).toContain('"count":2');
    const items = (await t.store.webhooks.deliveries(route.id))!.items;
    const lost = items.filter((item) => item.status === 'pending');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.history.map((h) => h.error)).toEqual(['the request is no longer stored']);
    expect(lost[0]!.batchId).toBeNull();
  });

  test('the sender process sends a batch route’s backlog as one request too', async () => {
    const receiver = listener((socket) =>
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
    );
    try {
      const source = await addSource(t);
      await addRoute(t, source.id, { url: `http://127.0.0.1:${receiver.port}/in`, batch: BATCH });
      for (let n = 1; n <= 5; n += 1) await t.store.sources.accept(source.id, post({ n }));
      const config = resolveWebhookConfig(
        { concurrency: 4, ratePerMinute: 100_000, idleMs: 20 },
        { allowHttp: true, allowPrivate: true }
      )!;
      const pooled = pooledSending(config);
      const stop = new AbortController();
      const loop = runWebhookLoop(
        t.store,
        { ...pooled.sending, now: () => t.clock.now() },
        noTelemetry,
        stop.signal
      );
      const deadline = Date.now() + 10_000;
      while (receiver.requests.length < 1 && Date.now() < deadline) await Bun.sleep(10);
      stop.abort();
      await loop;
      pooled.close();

      expect(receiver.requests).toHaveLength(1);
      expect(receiver.requests[0]).toContain('"count":5');
      const rows = await t.fresh.sql<
        Array<{ status: string }>
      >`SELECT status FROM qcloud_deliveries`;
      expect(rows.map((row) => row.status)).toEqual(Array(5).fill('delivered'));
    } finally {
      receiver.stop();
    }
  });

  test('the sender process takes a backlog of batches back to back, without an idle wait between them', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { batch: BATCH });
    for (let n = 1; n <= 250; n += 1) await t.store.sources.accept(source.id, post({ n }));
    // A claim takes one batch of a route, so it is shorter than the free slots. idleMs is far longer than this test
    // waits: a loop that took that for "nothing more due" would send the first 100 events and sit out the rest.
    const config = resolveWebhookConfig(
      { concurrency: 8, ratePerMinute: 100_000, idleMs: 30_000 },
      STRICT
    )!;
    let requests = 0;
    const stop = new AbortController();
    const loop = runWebhookLoop(
      t.store,
      {
        config,
        resolve: async () => [PUBLIC],
        post: async () => {
          requests += 1;
          return status(200);
        },
        now: () => t.clock.now(),
      },
      noTelemetry,
      stop.signal
    );
    const deadline = Date.now() + 3_000;
    while (requests < 3 && Date.now() < deadline) await Bun.sleep(10);
    stop.abort();
    await loop;

    expect(requests).toBe(3);
    const rows = await t.fresh.sql<Array<{ status: string }>>`SELECT status FROM qcloud_deliveries`;
    expect(rows.map((row) => row.status)).toEqual(Array(250).fill('delivered'));
  });
});
