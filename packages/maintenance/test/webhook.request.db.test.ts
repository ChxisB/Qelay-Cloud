import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_HEADERS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import { addRoute, addSource, post } from '../../store-postgres/test/inboundHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { KEY } from '../../store-postgres/test/webhookHelpers';
import { RecordingTransport } from './support';
import { senderHarness, status } from './webhookSending';

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

describeDb('webhook sender: a request is delivered through the tick (D14)', () => {
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

  test('{ "id": 500, "name": "chris" } posted with no shape reaches the destination as the same bytes', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id);
    const body = '{ "id": 500,   "name": "chris" }';
    await t.store.sources.accept(source.id, post(body));
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    const [seen] = s.seen;
    expect(text(seen!.request.bytes)).toBe(body);
    expect(seen!.request.contentType).toBe('application/json');
    expect(seen!.request.headers[WEBHOOK_HEADERS.event]).toBe('request.received');
    expect(seen!.request.headers[WEBHOOK_HEADERS.signature]).toMatch(/^v1=[0-9a-f]{64}$/u);
  });

  test('a shaped route sends the shaped JSON, and a plain-text request keeps its own content type', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { shape: { who: { $: 'body.name' } } });
    await t.store.sources.accept(source.id, post({ id: 500, name: 'chris' }));
    const s = sending(() => status(200));
    await s.pass();
    expect(s.seen[0]!.request.body).toBe('{"who":"chris"}');
    expect(s.seen[0]!.request.bytes).toBeUndefined();

    await resetTables(t);
    const plain = await addSource(t, { name: 'Plain' });
    await addRoute(t, plain.id);
    await t.store.sources.accept(
      plain.id,
      post('hello', { contentType: 'text/plain', headers: { 'content-type': 'text/plain' } })
    );
    const p = sending(() => status(200));
    await p.pass();
    expect(text(p.seen[0]!.request.bytes)).toBe('hello');
    expect(p.seen[0]!.request.contentType).toBe('text/plain');
  });

  test('a queue route adds a job whose data is the request body', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { destination: 'queue', url: undefined, target: 'refunds' });
    await t.store.sources.accept(source.id, post({ id: 500, name: 'chris' }));
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    const jobs = (await t.store.listJobs({ queue: 'refunds', limit: 10 })).items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'request.received', data: { id: 500, name: 'chris' } });
    expect(s.seen).toEqual([]);
  });

  test('a request the retention already removed fails the attempt with its reason', async () => {
    const source = await addSource(t);
    const route = await addRoute(t, source.id);
    await t.store.sources.accept(source.id, post({ id: 1 }));
    await t.fresh.sql`DELETE FROM qcloud_requests`;
    const s = sending(() => status(200));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 0 });
    expect(s.seen).toEqual([]);
    const page = await t.store.webhooks.deliveries(route.id);
    expect(page!.items[0]!.history.map((h) => h.error)).toEqual([
      'the request is no longer stored',
    ]);
  });
});
