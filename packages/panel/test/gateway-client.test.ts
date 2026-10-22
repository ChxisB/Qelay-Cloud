import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bq } from '../src/lib/bq';

interface Captured {
  path: string;
  method: string;
  body: unknown;
}

const originalFetch = globalThis.fetch;
let requests: Captured[] = [];
let answer: unknown = { ok: true };

beforeEach(() => {
  requests = [];
  answer = { ok: true };
  useConnectionStore.setState({ baseUrl: 'http://gateway.test', token: 'secret', agentToken: '' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body: request.body ? await request.json() : undefined,
    });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

const destination = {
  id: 'd:1',
  name: 'Billing',
  kind: 'http',
  url: 'https://billing.example.com/in',
  urlRedacted: false,
  target: null,
  connections: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe('event gateway client calls', () => {
  test('editing a connection patches it with only the keys given, and null clears', async () => {
    await bq.updateWebhook('h:1', { name: 'Orders', description: null, delayMs: 5_000 });
    expect(requests).toEqual([
      {
        path: '/webhooks/h:1',
        method: 'PATCH',
        body: { name: 'Orders', description: null, delayMs: 5_000 },
      },
    ]);
  });

  test('turning one off sends the mode only when one is given', async () => {
    await bq.setWebhookEnabled('h1', false);
    await bq.setWebhookEnabled('h1', false, 'hold');
    await bq.setWebhookEnabled('h1', true);
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['PUT', '/webhooks/h1/enabled', { enabled: false }],
      ['PUT', '/webhooks/h1/enabled', { enabled: false, mode: 'hold' }],
      ['PUT', '/webhooks/h1/enabled', { enabled: true }],
    ]);
  });

  test('issues are listed by status and webhook, and a status is set with PUT', async () => {
    answer = {
      ok: true,
      data: {
        issues: [],
        next: null,
        counts: { open: 0, acknowledged: 0, resolved: 0, ignored: 0 },
      },
    };
    await bq.webhookIssues();
    await bq.webhookIssues({ status: 'open', webhook: 'h1', limit: 25, before: '9' });
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/webhooks/issues'],
      ['GET', '/webhooks/issues?status=open&webhook=h1&limit=25&before=9'],
    ]);
    requests = [];
    answer = {
      ok: true,
      data: {
        issue: {
          id: 'i:1',
          webhookId: 'h1',
          webhookName: null,
          status: 'acknowledged',
          kind: 'delivery_failed',
          openedAt: 1,
          updatedAt: 2,
          updatedBy: null,
          consecutiveFailures: 1,
          alertLevel: 0,
          pausedBy: null,
        },
      },
    };
    expect((await bq.setWebhookIssueStatus('i:1', 'acknowledged')).status).toBe('acknowledged');
    expect(requests).toEqual([
      { path: '/webhooks/issues/i:1', method: 'PUT', body: { status: 'acknowledged' } },
    ]);
  });

  test('grouped stats ask for one entry per route over the window', async () => {
    answer = { ok: true, data: { since: 0, until: 10, bucketMs: 10, groups: [] } };
    await bq.webhookGroupStats({ since: 0, until: 10, buckets: 24 });
    expect(requests).toEqual([
      {
        path: '/webhooks/stats?groupBy=webhook&since=0&until=10&buckets=24',
        method: 'GET',
        body: undefined,
      },
    ]);
  });

  test('destinations are listed, saved, changed and removed at their own paths', async () => {
    answer = { ok: true, data: { destinations: [destination] } };
    expect(await bq.destinations()).toHaveLength(1);
    answer = { ok: true, data: { destination } };
    await bq.addDestination({ name: 'Billing', kind: 'http', url: destination.url });
    await bq.updateDestination('d:1', { name: 'Payments' });
    answer = { ok: true };
    await bq.removeDestination('d:1');
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['GET', '/webhooks/destinations', undefined],
      ['POST', '/webhooks/destinations', { name: 'Billing', kind: 'http', url: destination.url }],
      ['PATCH', '/webhooks/destinations/d:1', { name: 'Payments' }],
      ['DELETE', '/webhooks/destinations/d:1', undefined],
    ]);
  });

  test('a malformed answer is refused by name, so a screen never draws it', async () => {
    answer = { ok: true, data: { destinations: [{ ...destination, kind: 'ftp' }] } };
    await expect(bq.destinations()).rejects.toThrow('Malformed destinations response.');
    answer = { ok: true, data: { destination: { ...destination, connections: -1 } } };
    await expect(bq.addDestination({ name: 'x', kind: 'queue', target: 'q' })).rejects.toThrow(
      'Malformed destination response.'
    );
    answer = { ok: true, data: { since: 0, until: 1, bucketMs: 1, groups: [{}] } };
    await expect(bq.webhookGroupStats({ since: 0, until: 1 })).rejects.toThrow(
      'Malformed webhook group stats response.'
    );
    answer = { ok: true, data: { issues: [{}], next: null, counts: {} } };
    await expect(bq.webhookIssues()).rejects.toThrow('Malformed webhook issues response.');
  });

  test('a conflict from the server keeps its code for the screen', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'destination_in_use', message: 'in use', details: { connections: 2 } },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;
    const error = await bq.removeDestination('d1').catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 409,
      code: 'destination_in_use',
      details: { connections: 2 },
    });
  });
});

describe('connection ids that are not path-safe', () => {
  test.each(['', 'a/b', 'a?b', 'a#b', '..'])('%j is refused before a request is made', (id) => {
    expect(() => bq.updateWebhook(id, { name: 'x' })).toThrow(TypeError);
    expect(() => bq.removeDestination(id)).toThrow(TypeError);
    expect(requests).toEqual([]);
  });
});
