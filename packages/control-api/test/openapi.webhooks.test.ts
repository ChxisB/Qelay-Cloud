import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  addHook,
  CLAIM,
  event,
  journal,
  KEY,
  outcome,
  POLICY,
  SECRET,
} from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { keysFit, schema } from './openapiSpec';

// The same pin as the jobs bodies' in `openapi.jobs.test.ts`, for what the webhook routes serve.
describeDb('docs/openapi.yaml webhook bodies', () => {
  let f: JobsFixture;
  let api: JobsApi;
  let hookId: string;
  let deliveryId: string;

  beforeAll(async () => {
    f = await openJobsFixture({ webhookKey: KEY });
    api = f.api();
    hookId = (await addHook(f, { events: ['job.pushed'], secret: SECRET })).id;
    await journal(f.t, [event('pushed', 'q', 'j1')]);
    const claimed = await f.store.webhooks.claimDue(CLAIM);
    await f.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      { ...POLICY, maxAttempts: 1 }
    );
    deliveryId = claimed[0]!.deliveryId;
  });
  afterAll(() => f.drop());

  const fits = async (name: string, method: string, path: string, body?: unknown) => {
    const answer = await api.call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    expect(keysFit(answer.body, name), `${method} ${path}`).toEqual([]);
    return answer.body as Record<string, any>;
  };

  test('the webhook and its list, as they are served', async () => {
    const list = await fits('WebhooksList', 'GET', '/webhooks');
    for (const hook of list.data.webhooks) expect(keysFit(hook, 'Webhook')).toEqual([]);
    const one = await fits('WebhookEnvelope', 'GET', `/webhooks/${hookId}`);
    expect(keysFit(one.data.webhook, 'Webhook')).toEqual([]);
    const created = await fits('WebhookEnvelope', 'POST', '/webhooks', {
      url: 'https://hooks.example.com/b',
      events: ['job.completed'],
    });
    expect(keysFit(created.data.webhook, 'Webhook')).toEqual([]);
    await fits('WebhookEnvelope', 'PUT', `/webhooks/${hookId}/enabled`, { enabled: false });
    await fits('WebhookEnvelope', 'PUT', `/webhooks/${hookId}/enabled`, { enabled: true });
  });

  test('a delivery, its history, a test and a retry, as they are served', async () => {
    const page = await fits('DeliveriesPage', 'GET', `/webhooks/${hookId}/deliveries`);
    expect(page.data.deliveries.length).toBeGreaterThan(0);
    for (const delivery of page.data.deliveries) {
      expect(keysFit(delivery, 'WebhookDelivery')).toEqual([]);
      for (const attempt of delivery.history)
        expect(keysFit(attempt, 'WebhookAttempt')).toEqual([]);
    }
    const retried = await fits(
      'DeliveryEnvelope',
      'POST',
      `/webhooks/${hookId}/deliveries/${deliveryId}/retry`
    );
    expect(keysFit(retried.data.delivery, 'WebhookDelivery')).toEqual([]);
    const test_ = await fits('DeliveryEnvelope', 'POST', `/webhooks/${hookId}/test`);
    expect(keysFit(test_.data.delivery, 'WebhookDelivery')).toEqual([]);
    await fits('Ok', 'DELETE', `/webhooks/${hookId}`);
  });

  test('the create body names every field the route accepts, and the secret is never in a response schema', () => {
    expect(Object.keys(schema('WebhookCreate').properties ?? {}).sort()).toEqual([
      'enabled',
      'events',
      'queue',
      'secret',
      'url',
    ]);
    for (const name of ['Webhook', 'WebhookDelivery', 'WebhookAttempt']) {
      expect(Object.keys(schema(name).properties ?? {}), name).not.toContain('secret');
    }
  });
});
