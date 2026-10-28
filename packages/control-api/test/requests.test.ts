import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addRoute, post } from '../../store-postgres/test/inboundHelpers';
import { KEY } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('request routes: what the sources took', () => {
  let f: JobsFixture;
  let api: JobsApi;
  let source: string;
  beforeAll(async () => {
    f = await openJobsFixture({ webhookKey: KEY });
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
    source = (await f.store.sources.create({ name: 'Billing' }, 'me')).id;
  });

  const accept = async (body: unknown, extra = {}): Promise<string> => {
    const result = await f.store.sources.accept(source, post(body, extra));
    if (result.outcome !== 'accepted') throw new Error('not accepted');
    return result.id;
  };

  test('the list pages newest first by keyset, filters by source and status, and holds no body', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await accept({ n }));
    await f.store.sources.reject(source, post('x'), 'signature does not match');
    const first = (await api.call('GET', '/requests?limit=4')).body.data;
    expect(first.requests[0]).toMatchObject({
      status: 'rejected',
      cause: 'signature does not match',
      bodyBytes: null,
    });
    expect(Object.keys(first.requests[0]).sort()).toEqual(
      [
        'bodyBytes',
        'cause',
        'contentType',
        'id',
        'method',
        'receivedAt',
        'sourceId',
        'status',
      ].sort()
    );
    const second = (await api.call('GET', `/requests?limit=4&before=${first.next}`)).body.data;
    const seen = [...first.requests, ...second.requests].map((r: { id: string }) => r.id);
    expect(seen.slice(1)).toEqual([...ids].reverse());
    expect(second.next).toBeNull();
    const rejected = (await api.call('GET', `/requests?source=${source}&status=rejected`)).body
      .data;
    expect(rejected.requests).toHaveLength(1);
    expect((await api.call('GET', '/requests?source=nope')).body.data.requests).toEqual([]);
    for (const query of ['limit=0', 'limit=201', 'before=abc', 'status=pending', 'limit=a']) {
      expect((await api.call('GET', `/requests?${query}`)).status, query).toBe(400);
    }
  });

  test('one request comes whole with its deliveries, and its body only to an operator', async () => {
    const route = await addRoute(f, source);
    const id = await accept(
      { id: 500, name: 'chris' },
      {
        headers: { 'content-type': 'application/json', authorization: 'Bearer private-token' },
        query: { a: '1' },
      }
    );
    const one = (await api.call('GET', `/requests/${id}`)).body.data.request;
    expect(one).toMatchObject({
      id,
      sourceId: source,
      status: 'accepted',
      headers: { 'content-type': 'application/json', authorization: '[redacted]' },
      query: { a: '1' },
      bodyRedacted: false,
    });
    expect(one.body.encoding).toBe('utf8');
    expect(JSON.parse(one.body.data)).toEqual({ id: 500, name: 'chris' });
    expect(one.deliveries).toEqual([
      expect.objectContaining({
        webhookId: route.id,
        event: 'request.received',
        via: 'http',
        status: 'pending',
      }),
    ]);
    expect(JSON.stringify(one)).not.toContain('private-token');

    const seen = (await api.asViewer('GET', `/requests/${id}`)).body.data.request;
    expect(seen).toMatchObject({ body: null, bodyRedacted: true, bodyBytes: one.body.bytes });
    expect(JSON.stringify(seen)).not.toContain('chris');
    expect((await api.call('GET', '/requests/999999999')).body.error.code).toBe(
      'request_not_found'
    );
    expect((await api.call('GET', '/requests/abc')).status).toBe(400);
  });

  test('a body that is not text comes as base64', async () => {
    const result = await f.store.sources.accept(source, {
      ...post(''),
      contentType: 'application/octet-stream',
      body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    });
    const id = (result as { id: string }).id;
    const body = (await api.call('GET', `/requests/${id}`)).body.data.request.body;
    expect(body).toEqual({ encoding: 'base64', data: '//4AAQ==', bytes: 4 });
  });

  test('a replay makes new deliveries; a rejected or unknown request is refused; it is audited', async () => {
    await addRoute(f, source);
    const id = await accept({ id: 7 });
    f.t.clock.advance(5);
    const replayed = await api.call('POST', `/requests/${id}/replay`);
    expect(replayed.status).toBe(202);
    expect(replayed.body.data).toEqual({ routes: 1, deliveries: 1 });
    expect((await api.call('GET', `/requests/${id}`)).body.data.request.deliveries).toHaveLength(2);

    await f.store.sources.reject(source, post('x'), 'bad');
    const [rejected] = (await f.store.sources.requests({ status: 'rejected' })).items;
    const refused = await api.call('POST', `/requests/${rejected!.id}/replay`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('request_not_replayable');
    const unknown = await api.call('POST', '/requests/999999999/replay');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('request_not_found');
    expect((await api.asViewer('POST', `/requests/${id}/replay`)).status).toBe(403);
    const rows = (await f.store.audit.list({ limit: 100 })).items.filter((row) =>
      row.action.includes('/replay')
    );
    expect(rows.map((row) => [row.action, row.status, row.target]).reverse()).toEqual([
      ['POST /requests/:id/replay', 202, `id=${id}`],
      ['POST /requests/:id/replay', 409, `id=${rejected!.id}`],
      ['POST /requests/:id/replay', 404, 'id=999999999'],
      ['POST /requests/:id/replay', 403, `id=${id}`],
    ]);
  });
});
