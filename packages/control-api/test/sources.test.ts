import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MAX_SOURCES } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { KEY } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const SECRET = 'a-secret-the-caller-chose-0123456789';
const ROUTE_URL = 'https://hooks.example.com/in';

describeDb('source routes: inbound sources', () => {
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

  const make = (body: Record<string, unknown> = { name: 'Billing' }) =>
    api.call('POST', '/sources', body);
  const idOf = async (body?: Record<string, unknown>): Promise<string> =>
    (await make(body)).body.data.source.id;
  const signed = { name: 'Signed', verification: { kind: 'hmac', header: 'X-Signature' } };

  test('a source is made with its token shown once, and no read returns the token or a secret', async () => {
    const created = await make();
    expect(created.status).toBe(201);
    expect(created.body.data.source).toMatchObject({
      name: 'Billing',
      enabled: true,
      verification: { kind: 'none', header: null, username: null },
      signed: false,
      rejectedDropped: 0,
    });
    expect(typeof created.body.data.token).toBe('string');
    expect(created.body.data.secret).toBeUndefined();
    expect(Object.keys(created.body.data.source)).not.toContain('createdBy');
    const id = created.body.data.source.id;
    expect((await f.store.sources.findByToken(created.body.data.token))!.id).toBe(id);

    const made = await make(signed);
    expect(made.body.data.source).toMatchObject({ signed: true, verification: { kind: 'hmac' } });
    expect(typeof made.body.data.secret).toBe('string');
    const given = await make({ ...signed, name: 'Given', secret: SECRET });
    expect(given.body.data.secret).toBeUndefined();

    const reads = [
      await api.call('GET', '/sources'),
      await api.call('GET', `/sources/${id}`),
      await api.call('GET', `/sources/${made.body.data.source.id}`),
    ];
    const text = JSON.stringify(reads.map((r) => r.body));
    for (const hidden of [
      created.body.data.token,
      made.body.data.token,
      made.body.data.secret,
      SECRET,
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(reads[0]!.body.data.sources.map((s: { name: string }) => s.name)).toEqual([
      'Billing',
      'Signed',
      'Given',
    ]);
  });

  test('a body that does not fit is a 400, a name is unique, and the namespace keeps at most MAX_SOURCES', async () => {
    for (const body of [
      {},
      { name: 'a', x: 1 },
      { name: 'a', verification: { kind: 'oauth' } },
      { name: 'a', verification: { kind: 'hmac', x: 1 } },
    ]) {
      expect((await make(body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const [body, option] of [
      [{ name: '  ' }, 'name'],
      [{ name: 'a', verification: { kind: 'hmac' } }, 'verification'],
      [{ name: 'a', secret: SECRET }, 'secret'],
    ] as const) {
      const answer = await make(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.details?.option, JSON.stringify(body)).toBe(option);
    }
    await make();
    const taken = await make();
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('source_name_taken');
    for (let n = 1; n < MAX_SOURCES; n++) await f.store.sources.create({ name: `s${n}` }, 'me');
    const full = await make({ name: 'one too many' });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({
      code: 'source_limit',
      details: { limit: MAX_SOURCES },
    });
  });

  test('a source is renamed and turned off; verification is not editable; unknown ones are 404', async () => {
    const id = await idOf();
    const patched = await api.call('PATCH', `/sources/${id}`, { name: 'Payments', enabled: false });
    expect(patched.body.data.source).toMatchObject({ name: 'Payments', enabled: false });
    for (const body of [{}, { verification: { kind: 'hmac' } }]) {
      expect((await api.call('PATCH', `/sources/${id}`, body)).status).toBe(400);
    }
    for (const [method, path] of [
      ['GET', '/sources/nope'],
      ['PATCH', '/sources/nope'],
      ['DELETE', '/sources/nope'],
      ['POST', '/sources/nope/rotate-token'],
      ['POST', '/sources/nope/rotate-secret'],
    ] as const) {
      const answer = await api.call(method, path, method === 'PATCH' ? { name: 'x' } : undefined);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.body.error.code).toBe('source_not_found');
    }
  });

  test('a new token stops the old URL at once, and a new secret keeps the old one for a day', async () => {
    const created = await make(signed);
    const id = created.body.data.source.id;
    const rotated = await api.call('POST', `/sources/${id}/rotate-token`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.token).not.toBe(created.body.data.token);
    expect(rotated.body.data.secret).toBeUndefined();
    expect(await f.store.sources.findByToken(created.body.data.token)).toBeNull();
    expect((await f.store.sources.findByToken(rotated.body.data.token))!.id).toBe(id);

    const again = await api.call('POST', `/sources/${id}/rotate-secret`);
    expect(again.status).toBe(200);
    expect(again.body.data.secret).not.toBe(created.body.data.secret);
    expect(again.body.data.token).toBeUndefined();
    expect(again.body.data.source.previousSecretUntil).toBeGreaterThan(f.t.clock.now());
    const auth = (await f.store.sources.findByToken(rotated.body.data.token))!;
    expect([auth.secret, auth.previousSecret]).toEqual([
      again.body.data.secret,
      created.body.data.secret,
    ]);

    const chosen = await api.call('POST', `/sources/${id}/rotate-secret`, { secret: SECRET });
    expect(chosen.body.data.secret).toBeUndefined();
    expect((await f.store.sources.findByToken(rotated.body.data.token))!.secret).toBe(SECRET);
    const open = await idOf({ name: 'Open' });
    const refused = await api.call('POST', `/sources/${open}/rotate-secret`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details?.option).toBe('secret');
  });

  test('a route is made for a source, and the source is in use until the route goes', async () => {
    const id = await idOf();
    const route = await api.call('POST', '/webhooks', { source: id, url: ROUTE_URL });
    expect(route.status).toBe(201);
    expect(route.body.data.webhook).toMatchObject({ source: id });
    for (const extra of [{ events: ['request.received'] }, { queue: 'q' }]) {
      const answer = await api.call('POST', '/webhooks', { source: id, url: ROUTE_URL, ...extra });
      expect(answer.status, JSON.stringify(extra)).toBe(400);
    }
    const unknown = await api.call('POST', '/webhooks', { source: 'nope', url: ROUTE_URL });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details?.option).toBe('source');
    expect((await api.call('POST', '/webhooks', { url: ROUTE_URL })).status).toBe(400);

    const other = await idOf({ name: 'Other' });
    const hook = route.body.data.webhook.id;
    const moved = await api.call('PATCH', `/webhooks/${hook}`, { source: other });
    expect(moved.body.data.webhook.source).toBe(other);
    const refused = await api.call('DELETE', `/sources/${other}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'source_in_use', details: { routes: 1 } });
    expect((await api.call('DELETE', `/webhooks/${hook}`)).status).toBe(200);
    expect((await api.call('DELETE', `/sources/${other}`)).status).toBe(200);
    expect((await api.call('DELETE', `/sources/${other}`)).status).toBe(404);
  });

  test('a viewer reads sources and cannot write', async () => {
    const id = await idOf();
    expect((await api.asViewer('GET', '/sources')).body.data.sources).toHaveLength(1);
    expect((await api.asViewer('GET', `/sources/${id}`)).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/sources', { name: 'x' }],
      ['PATCH', `/sources/${id}`, { name: 'x' }],
      ['POST', `/sources/${id}/rotate-token`, undefined],
      ['POST', `/sources/${id}/rotate-secret`, undefined],
      ['DELETE', `/sources/${id}`, undefined],
    ] as const) {
      expect((await api.asViewer(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await api.call('GET', '/sources')).body.data.sources).toHaveLength(1);
  });

  test('the audit rows hold the source id and neither a token, a secret nor a name', async () => {
    const created = await make({ ...signed, name: 'private-looking-name', secret: SECRET });
    const id = created.body.data.source.id;
    const token = (await api.call('POST', `/sources/${id}/rotate-token`)).body.data.token;
    const secret = (await api.call('POST', `/sources/${id}/rotate-secret`)).body.data.secret;
    await api.call('DELETE', `/sources/${id}`);
    const rows = [...(await f.store.audit.list({ limit: 100 })).items].reverse();
    const mine = rows.filter((row) => row.action.includes('/sources'));
    expect(mine.map((row) => [row.action, row.status, row.target])).toEqual([
      ['POST /sources', 201, `source=${id}`],
      ['POST /sources/:id/rotate-token', 200, `id=${id}`],
      ['POST /sources/:id/rotate-secret', 200, `id=${id}`],
      ['DELETE /sources/:id', 200, `id=${id}`],
    ]);
    const text = JSON.stringify(rows);
    for (const hidden of [created.body.data.token, token, secret, SECRET, 'private-looking-name']) {
      expect(text).not.toContain(hidden);
    }
  });
});
