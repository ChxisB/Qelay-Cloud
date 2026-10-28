import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MAX_DESTINATIONS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { addHook, hookSource, KEY } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const PRIVATE_URL = 'https://billing.example.com/in?token=private-path-token';

describeDb('webhook routes: saved destinations', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture({ webhookKey: KEY });
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
  });

  const save = (
    body: Record<string, unknown> = { name: 'Billing', kind: 'http', url: PRIVATE_URL }
  ) => api.call('POST', '/webhooks/destinations', body);
  const idOf = async (body?: Record<string, unknown>) =>
    (await save(body)).body.data.destination.id;
  const connect = async (body: Record<string, unknown>) =>
    api.call('POST', '/webhooks', { source: await hookSource(f), ...body });

  test('a destination is saved, listed with its connection count, and read back whole to an operator', async () => {
    const created = await save();
    expect(created.status).toBe(201);
    expect(created.body.data.destination).toMatchObject({
      name: 'Billing',
      kind: 'http',
      url: PRIVATE_URL,
      urlRedacted: false,
      target: null,
      connections: 0,
    });
    expect(Object.keys(created.body.data.destination)).not.toContain('createdBy');
    await save({ name: 'Orders', kind: 'queue', target: 'orders' });
    const list = (await api.call('GET', '/webhooks/destinations')).body.data.destinations;
    expect(list.map((d: { name: string }) => d.name)).toEqual(['Billing', 'Orders']);
    expect(list[1]).toMatchObject({ kind: 'queue', url: '', urlRedacted: false, target: 'orders' });
  });

  test('an address that fails the check is refused as on a webhook, and nothing is saved', async () => {
    for (const [url, code] of [
      ['http://billing.example.com/in', 'scheme_not_allowed'],
      ['not a url', 'invalid_url'],
      ['https://user:pw@billing.example.com/', 'credentials_not_allowed'],
      ['https://127.0.0.1/in', 'host_not_allowed'],
    ] as const) {
      const answer = await save({ name: 'Bad', kind: 'http', url });
      expect(answer.status, url).toBe(400);
      expect(answer.body.error.code, url).toBe(code);
      expect(JSON.stringify(answer.body.error)).not.toContain('billing.example.com');
    }
    const id = await idOf();
    const moved = await api.call('PATCH', `/webhooks/destinations/${id}`, {
      url: 'http://billing.example.com/in',
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe('scheme_not_allowed');
    expect((await api.call('GET', '/webhooks/destinations')).body.data.destinations).toHaveLength(
      1
    );
    expect((await f.store.webhooks.getDestination(id))!.url).toBe(PRIVATE_URL);
  });

  test('a body or a kind that does not fit is a 400 naming the option', async () => {
    for (const [body, option] of [
      [{ name: '  ', kind: 'http', url: PRIVATE_URL }, 'name'],
      [{ name: 'a', kind: 'http' }, 'url'],
      [{ name: 'a', kind: 'queue' }, 'target'],
      [{ name: 'a', kind: 'queue', target: 'q', url: PRIVATE_URL }, 'url'],
    ] as const) {
      const answer = await save(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.details?.option, JSON.stringify(body)).toBe(option);
    }
    for (const body of [
      {},
      { name: 'a' },
      { name: 'a', kind: 'workflow' },
      { name: 'a', kind: 'http', x: 1 },
    ]) {
      expect((await save(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.call('GET', '/webhooks/destinations')).body.data.destinations).toEqual([]);
  });

  test('a name is unique and the namespace keeps at most MAX_DESTINATIONS', async () => {
    await save();
    const taken = await save({ name: 'Billing', kind: 'http', url: 'https://other.example.com/' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('destination_name_taken');
    await f.t.fresh.sql.unsafe(
      `INSERT INTO qcloud_webhook_destinations
         (namespace, id, name, kind, url, created_by, created_at, updated_at)
       SELECT namespace, 'x' || g, 'filler ' || g, 'http', 'https://x.example.com/', 'me', g, g
       FROM (SELECT DISTINCT namespace FROM qcloud_webhook_destinations) n,
            generate_series(1, ${MAX_DESTINATIONS - 1}) g`
    );
    const full = await save({ name: 'one too many', kind: 'http', url: 'https://x.example.com/' });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({
      code: 'destination_limit',
      details: { limit: MAX_DESTINATIONS },
    });
  });

  test('a connection is made from a destination, and refused when it also gives an address', async () => {
    const id = await idOf();
    const made = await connect({ destinationId: id, name: 'Orders to billing' });
    expect(made.status).toBe(201);
    expect(made.body.data.webhook).toMatchObject({
      destination: 'http',
      url: PRIVATE_URL,
      destinationId: id,
    });
    expect(typeof made.body.data.secret).toBe('string');
    expect(
      (await api.call('GET', '/webhooks/destinations')).body.data.destinations[0].connections
    ).toBe(1);
    expect((await addHook(f)).destinationId).toBeNull();
    for (const extra of [
      { url: 'https://other.example.com/' },
      { target: 'q' },
      { destination: 'http' },
    ]) {
      const answer = await connect({ destinationId: id, ...extra });
      expect(answer.status, JSON.stringify(extra)).toBe(400);
      expect(answer.body.error.details?.option).toBe('destinationId');
    }
    const unknown = await connect({ destinationId: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details?.option).toBe('destinationId');
    expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(2);
  });

  test('a new address reaches every connection made from the destination', async () => {
    const id = await idOf();
    const a = (await connect({ destinationId: id })).body.data.webhook.id;
    const other = (await connect({ url: 'https://elsewhere.example.com/' })).body.data.webhook.id;
    const moved = await api.call('PATCH', `/webhooks/destinations/${id}`, {
      url: 'https://billing.example.com/v2',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data.destination).toMatchObject({
      url: 'https://billing.example.com/v2',
      connections: 1,
    });
    expect((await api.call('GET', `/webhooks/${a}`)).body.data.webhook.url).toBe(
      'https://billing.example.com/v2'
    );
    expect((await api.call('GET', `/webhooks/${other}`)).body.data.webhook.url).toBe(
      'https://elsewhere.example.com/'
    );
    const renamed = await api.call('PATCH', `/webhooks/destinations/${id}`, { name: 'Payments' });
    expect(renamed.body.data.destination.name).toBe('Payments');
  });

  test('a destination in use is a 409 with the count, and goes once its connections are gone', async () => {
    const id = await idOf();
    const hook = (await connect({ destinationId: id })).body.data.webhook;
    const refused = await api.call('DELETE', `/webhooks/destinations/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'destination_in_use',
      details: { connections: 1 },
    });
    expect((await api.call('DELETE', `/webhooks/${hook.id}`)).status).toBe(200);
    expect((await api.call('DELETE', `/webhooks/destinations/${id}`)).status).toBe(200);
    const again = await api.call('DELETE', `/webhooks/destinations/${id}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('destination_not_found');
    expect((await api.call('PATCH', '/webhooks/destinations/nope', { name: 'x' })).status).toBe(
      404
    );
    expect((await api.call('PATCH', `/webhooks/destinations/${id}`, {})).status).toBe(400);
  });

  test('a viewer reads the origin only and cannot write', async () => {
    const id = await idOf();
    const seen = (await api.asViewer('GET', '/webhooks/destinations')).body.data.destinations[0];
    expect(seen).toMatchObject({ url: 'https://billing.example.com/', urlRedacted: true });
    expect(JSON.stringify(seen)).not.toContain('private-path-token');
    for (const [method, path, body] of [
      ['POST', '/webhooks/destinations', { name: 'x', kind: 'queue', target: 'q' }],
      ['PATCH', `/webhooks/destinations/${id}`, { name: 'x' }],
      ['DELETE', `/webhooks/destinations/${id}`, undefined],
    ] as const) {
      expect((await api.asViewer(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await f.store.webhooks.getDestination(id))!.name).toBe('Billing');
  });

  test('the audit rows hold ids and no address or name', async () => {
    const id = await idOf({ name: 'private-looking-name', kind: 'http', url: PRIVATE_URL });
    await api.call('PATCH', `/webhooks/destinations/${id}`, {
      url: 'https://billing.example.com/v3?t=secret-two',
    });
    await api.call('DELETE', `/webhooks/destinations/${id}`);
    const rows = [...(await f.store.audit.list({ limit: 100 })).items].reverse();
    const mine = rows.filter((row) => row.action.includes('/webhooks/destinations'));
    expect(mine.map((row) => [row.action, row.status])).toEqual([
      ['POST /webhooks/destinations', 201],
      ['PATCH /webhooks/destinations/:id', 200],
      ['DELETE /webhooks/destinations/:id', 200],
    ]);
    expect(mine[0]!.target).toBe(`destination=${id}`);
    expect(mine[1]!.target).toBe(`id=${id}`);
    const text = JSON.stringify(rows);
    for (const secret of ['private-path-token', 'secret-two', 'private-looking-name']) {
      expect(text).not.toContain(secret);
    }
  });
});
