import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { KEY, SECRET } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const ENDPOINT = { url: 'https://hooks.example.com/in', events: ['job.completed'] };
const MADE = /^whsec_[0-9a-f]{64}$/;

describeDb('webhook routes: generated and rotated secrets', () => {
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

  test('a webhook made without a secret gets one, shown once, and is signed', async () => {
    const made = await api.call('POST', '/webhooks', ENDPOINT);
    expect(made.status).toBe(201);
    expect(made.body.data.secret).toMatch(MADE);
    expect(made.body.data.webhook).toMatchObject({
      signed: true,
      consecutiveFailures: 0,
      alertLevel: 0,
      disabledReason: null,
      disabledAt: null,
      previousSecretUntil: null,
    });
    expect(made.body.data.webhook).not.toHaveProperty('secret');
    const read = await api.call('GET', `/webhooks/${made.body.data.webhook.id}`);
    expect(JSON.stringify(read.body)).not.toContain(made.body.data.secret);
    // A secret the caller gave is never echoed.
    const given = await api.call('POST', '/webhooks', { ...ENDPOINT, secret: SECRET });
    expect(given.body.data).not.toHaveProperty('secret');
    expect(JSON.stringify(given.body)).not.toContain(SECRET);
  });

  test('rotating generates one, or takes the one given, and the old one signs on for a while', async () => {
    const { id } = (await api.call('POST', '/webhooks', { ...ENDPOINT, secret: SECRET })).body.data
      .webhook;
    const generated = await api.call('POST', `/webhooks/${id}/rotate-secret`);
    expect(generated.status).toBe(200);
    expect(generated.body.data.secret).toMatch(MADE);
    expect(generated.body.data.webhook.previousSecretUntil).toBeGreaterThan(Date.now());

    const mine = 'whsec_mine0123456789abcdef0123456789ab';
    const given = await api.call('POST', `/webhooks/${id}/rotate-secret`, { secret: mine });
    expect(given.status).toBe(200);
    expect(given.body.data).not.toHaveProperty('secret');
    expect(JSON.stringify(given.body)).not.toContain(mine);
  });

  test('a missing webhook is 404, a short secret 400, and a viewer may not rotate', async () => {
    const { id } = (await api.call('POST', '/webhooks', ENDPOINT)).body.data.webhook;
    expect((await api.call('POST', '/webhooks/nope/rotate-secret')).status).toBe(404);
    const short = await api.call('POST', `/webhooks/${id}/rotate-secret`, { secret: 'short' });
    expect(short.status).toBe(400);
    expect((await api.asViewer('POST', `/webhooks/${id}/rotate-secret`)).status).toBe(403);
  });
});
