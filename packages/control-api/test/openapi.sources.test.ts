import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addRoute, post } from '../../store-postgres/test/inboundHelpers';
import { KEY } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { keysFit, schema } from './openapiSpec';

// The same pin as `openapi.webhooks.test.ts`, for what the source and request routes serve.
describeDb('docs/openapi.yaml source and request bodies', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture({ webhookKey: KEY });
    api = f.api();
  });
  afterAll(() => f.drop());

  const fits = async (name: string, method: string, path: string, body?: unknown) => {
    const answer = await api.call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    expect(keysFit(answer.body, name), `${method} ${path}`).toEqual([]);
    return answer.body as Record<string, any>;
  };

  test('the source, the request and their envelopes, as they are served', async () => {
    const created = await fits('SourceIssuedEnvelope', 'POST', '/sources', {
      name: 'Billing',
      verification: { kind: 'hmac', header: 'x-signature' },
    });
    const source = created.data.source;
    expect(keysFit(source, 'Source')).toEqual([]);
    const list = await fits('SourcesList', 'GET', '/sources');
    for (const one of list.data.sources) expect(keysFit(one, 'Source')).toEqual([]);
    await fits('SourceEnvelope', 'GET', `/sources/${source.id}`);
    await fits('SourceEnvelope', 'PATCH', `/sources/${source.id}`, { enabled: false });
    await fits('SourceIssuedEnvelope', 'POST', `/sources/${source.id}/rotate-secret`);
    await fits('SourceIssuedEnvelope', 'POST', `/sources/${source.id}/rotate-token`);

    await addRoute(f, source.id);
    await f.store.sources.update(source.id, { enabled: true });
    const accepted = await f.store.sources.accept(source.id, post({ id: 1 }));
    const id = (accepted as { id: string }).id;
    await f.store.sources.reject(source.id, post('x'), 'signature does not match');
    const requests = await fits('RequestsList', 'GET', '/requests');
    for (const one of requests.data.requests) expect(keysFit(one, 'InboundRequest')).toEqual([]);
    const detail = await fits('RequestEnvelope', 'GET', `/requests/${id}`);
    expect(keysFit(detail.data.request, 'InboundRequestDetail')).toEqual([]);
    const { via, ...delivery } = detail.data.request.deliveries[0];
    expect(via).toBe('http');
    expect(keysFit(delivery, 'WebhookDelivery')).toEqual([]);
    await fits('ReplayEnvelope', 'POST', `/requests/${id}/replay`);
    await fits('Ok', 'DELETE', `/webhooks/${(await f.store.webhooks.list())[0]!.id}`);
    await fits('Ok', 'DELETE', `/sources/${source.id}`);
  });

  test('the create body names every field the route accepts, and no secret or token is in a read schema', () => {
    expect(Object.keys(schema('SourceCreate').properties ?? {}).sort()).toEqual([
      'enabled',
      'name',
      'secret',
      'verification',
    ]);
    expect(Object.keys(schema('SourcePatch').properties ?? {}).sort()).toEqual(['enabled', 'name']);
    for (const name of ['Source', 'InboundRequest', 'InboundRequestDetail']) {
      const keys = Object.keys(schema(name).properties ?? {});
      expect(keys, name).not.toContain('secret');
      expect(keys, name).not.toContain('token');
      expect(keys, name).not.toContain('createdBy');
    }
  });
});
