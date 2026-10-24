import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addHook, hookSource, KEY, SECRET } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const URL_WITH_TOKEN =
  'https://hooks.example.com/services/T000/B000/xoxb-private-path-token?k=query-token';
const ENDPOINT = { url: URL_WITH_TOKEN, secret: SECRET };

const PREVIEW = { request: { method: 'POST', body: { id: 500, name: 'chris' } } };

describeDb('webhook routes', () => {
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

  /** A route of the hooks source unless the body names another. */
  const create = async (body: Record<string, unknown> = ENDPOINT) =>
    api.call('POST', '/webhooks', { source: await hookSource(f), ...body });

  test('registering answers 201 with the webhook, signed, and not a trace of the secret', async () => {
    const answer = await create();
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      ok: true,
      data: {
        webhook: {
          url: URL_WITH_TOKEN,
          urlRedacted: false,
          source: await hookSource(f),
          signed: true,
          enabled: true,
          lastTriggered: null,
          successCount: 0,
          failureCount: 0,
        },
      },
    });
    expect(typeof answer.body.data.webhook.id).toBe('string');
    expect(answer.body.data.webhook.createdAt).toBeGreaterThan(0);
    expect(JSON.stringify(answer.body)).not.toContain(SECRET);
    expect(answer.body.data.webhook).not.toHaveProperty('secret');
  });

  test('no read of a webhook, a test or a history ever carries the secret', async () => {
    const { id } = (await create()).body.data.webhook;
    const bodies = [
      await api.call('GET', '/webhooks'),
      await api.call('GET', `/webhooks/${id}`),
      await api.call('POST', `/webhooks/${id}/test`),
      await api.call('GET', `/webhooks/${id}/deliveries`),
      await api.asViewer('GET', '/webhooks'),
      await api.asViewer('GET', `/webhooks/${id}`),
      await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: false }),
    ];
    for (const answer of bodies) {
      expect(answer.status).toBeLessThan(300);
      expect(JSON.stringify(answer.body)).not.toContain(SECRET);
      // `previousSecretUntil` is a time, not a secret.
      expect(JSON.stringify(answer.body).replace('previousSecretUntil', '')).not.toMatch(
        /secret/iu
      );
    }
  });

  test('the list is the panel shape: webhooks and their count, oldest first', async () => {
    await create();
    await create({ url: 'https://other.example.com/in', enabled: false });
    const answer = await api.call('GET', '/webhooks');
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.data.stats).toEqual({ total: 2, enabled: 1 });
    expect(answer.body.data.webhooks.map((hook: { url: string }) => hook.url)).toEqual([
      URL_WITH_TOKEN,
      'https://other.example.com/in',
    ]);
    // The store has a key, so a webhook made without a secret is signed all the same.
    expect(answer.body.data.webhooks[1]).toMatchObject({ signed: true, enabled: false });
  });

  test('a viewer reads webhooks but sees only where each points, not the path a token may be in', async () => {
    const { id } = (await create()).body.data.webhook;
    const list = await api.asViewer('GET', '/webhooks');
    expect(list.body.data.webhooks[0]).toMatchObject({
      url: 'https://hooks.example.com/',
      urlRedacted: true,
    });
    const one = await api.asViewer('GET', `/webhooks/${id}`);
    expect(one.body.data.webhook).toMatchObject({
      url: 'https://hooks.example.com/',
      urlRedacted: true,
    });
    for (const answer of [list, one]) {
      expect(JSON.stringify(answer.body)).not.toContain('xoxb-private-path-token');
      expect(JSON.stringify(answer.body)).not.toContain('query-token');
    }
    // An operator sees the whole address.
    expect((await api.call('GET', `/webhooks/${id}`)).body.data.webhook.url).toBe(URL_WITH_TOKEN);
  });

  test('a viewer cannot register, change, test, delete or retry', async () => {
    const { id } = (await create()).body.data.webhook;
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/webhooks', ENDPOINT],
      ['PUT', `/webhooks/${id}/enabled`, { enabled: false }],
      ['DELETE', `/webhooks/${id}`],
      ['POST', `/webhooks/${id}/test`],
      ['POST', `/webhooks/${id}/deliveries/1/retry`],
      ['POST', '/webhooks/preview', PREVIEW],
    ];
    for (const [method, path, body] of attempts) {
      const answer = await api.asViewer(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
    expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(1);
  });

  describe('the address', () => {
    const refused = async (url: string) => {
      const answer = await create({ url });
      expect(answer.status, url).toBe(400);
      return answer.body.error;
    };

    test('is https only, and a refusal names the rule and not the address', async () => {
      const error = await refused('http://hooks.example.com/in');
      expect(error.code).toBe('scheme_not_allowed');
      expect(JSON.stringify(error)).not.toContain('hooks.example.com');
      expect((await refused('ftp://hooks.example.com/')).code).toBe('scheme_not_allowed');
      expect((await refused('not a url')).code).toBe('invalid_url');
      expect((await refused('https://user:pw@hooks.example.com/')).code).toBe(
        'credentials_not_allowed'
      );
    });

    test('refuses loopback, private, link-local and metadata destinations', async () => {
      for (const url of [
        'https://127.0.0.1/',
        'https://localhost/',
        'https://10.0.0.5/',
        'https://192.168.1.1/',
        'https://169.254.169.254/latest/meta-data/',
        'https://metadata.google.internal/',
        'https://[::1]/',
        'https://[fd00::1]/',
        'https://[::ffff:127.0.0.1]/',
        'https://2130706433/',
        'https://0x7f000001/',
      ]) {
        expect((await refused(url)).code, url).toBe('host_not_allowed');
      }
      expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(0);
    });

    test('development mode allows http and a loopback receiver', async () => {
      const dev = f.api(undefined, { webhookUrlPolicy: { allowHttp: true, allowPrivate: true } });
      const answer = await dev.call('POST', '/webhooks', {
        url: 'http://127.0.0.1:8080/hook',
        source: await hookSource(f),
      });
      expect(answer.status).toBe(201);
      // Credentials in the URL are never allowed, development or not.
      const credentials = await dev.call('POST', '/webhooks', {
        url: 'http://u:p@127.0.0.1/',
        source: await hookSource(f),
      });
      expect(credentials.status).toBe(400);
    });
  });

  describe('the body', () => {
    const bad = async (body: Record<string, unknown>) => {
      const answer = await create(body);
      expect(answer.status, JSON.stringify(Object.keys(body))).toBe(400);
      return answer.body.error;
    };
    const base = { url: 'https://hooks.example.com/in' };

    test('needs a known source, an address and nothing it does not know', async () => {
      await bad({ ...base, source: 'nope' });
      await bad({ ...base, source: null });
      await bad({ ...base, events: ['request.received'] });
      await bad({ ...base, queue: 'q' });
      await bad({});
      await bad({ ...base, extra: 1 });
      await bad({ ...base, enabled: 'yes' });
    });

    test('a short secret is refused by name, without repeating it', async () => {
      const short = await bad({ ...base, secret: 'too-short' });
      expect(short.code).toBe('unsupported_option');
      expect(JSON.stringify(short)).toContain('secret');
      expect(JSON.stringify(short)).not.toContain('too-short');
    });
  });

  test('a secret on a deployment with no webhook key is 409, and an unsigned webhook is still allowed', async () => {
    const keyless = await openJobsFixture();
    try {
      const keyed = keyless.api();
      const source = await hookSource(keyless);
      const refused = await keyed.call('POST', '/webhooks', { ...ENDPOINT, source });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('webhook_key_missing');
      expect(JSON.stringify(refused.body)).not.toContain(SECRET);
      const unsigned = await keyed.call('POST', '/webhooks', {
        ...ENDPOINT,
        source,
        secret: undefined,
      });
      expect(unsigned.status).toBe(201);
      expect(unsigned.body.data.webhook.signed).toBe(false);
    } finally {
      await keyless.drop();
    }
  });

  test('a namespace can register only so many, and the refusal says how many', async () => {
    for (let i = 0; i < 100; i += 1) await addHook(f, { url: `https://h${i}.example.com/` });
    const answer = await create();
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatchObject({ code: 'webhook_limit', details: { limit: 100 } });
  });

  test('enabling and disabling answers with the webhook; an unknown id is 404', async () => {
    const { id } = (await create()).body.data.webhook;
    const off = await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data.webhook.enabled).toBe(false);
    expect(
      (await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: true })).body.data.webhook
        .enabled
    ).toBe(true);
    expect((await api.call('PUT', '/webhooks/nope/enabled', { enabled: true })).status).toBe(404);
    expect((await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: 'on' })).status).toBe(400);
    expect((await api.call('PUT', `/webhooks/${id}/enabled`, {})).status).toBe(400);
  });

  test('deleting removes the webhook and its deliveries; a second delete is 404', async () => {
    const { id } = (await create()).body.data.webhook;
    await api.call('POST', `/webhooks/${id}/test`);
    expect((await api.call('DELETE', `/webhooks/${id}`)).status).toBe(200);
    expect((await api.call('GET', `/webhooks/${id}`)).status).toBe(404);
    expect((await api.call('GET', `/webhooks/${id}/deliveries`)).status).toBe(404);
    expect((await api.call('DELETE', `/webhooks/${id}`)).status).toBe(404);
    const [{ n }] = await f.t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_deliveries`;
    expect(n).toBe(0);
  });

  test('the capabilities say webhooks are on wherever the routes are served', async () => {
    const answer = await api.call('GET', '/capabilities');
    expect(answer.body.features.webhooks).toBe(true);
  });
});
