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
    const edited = await fits('WebhookEnvelope', 'PATCH', `/webhooks/${hookId}`, {
      name: 'Orders',
      description: 'to billing',
    });
    expect(keysFit(edited.data.webhook, 'Webhook')).toEqual([]);
    const held = await fits('WebhookEnvelope', 'PUT', `/webhooks/${hookId}/enabled`, {
      enabled: false,
      mode: 'hold',
    });
    expect(held.data.webhook.pausedBy).toBe('operator');
    await fits('WebhookEnvelope', 'PUT', `/webhooks/${hookId}/enabled`, { enabled: false });
    await fits('WebhookEnvelope', 'PUT', `/webhooks/${hookId}/enabled`, { enabled: true });
  });

  test('the cross-route feed, the stats and the bulk retry, as they are served', async () => {
    const feed = await fits('DeliveriesPage', 'GET', '/webhooks/deliveries');
    expect(feed.data.deliveries.length).toBeGreaterThan(0);
    for (const delivery of feed.data.deliveries) {
      expect(keysFit(delivery, 'WebhookDelivery')).toEqual([]);
    }
    const now = f.t.clock.now();
    const stats = await fits(
      'WebhookStatsEnvelope',
      'GET',
      `/webhooks/stats?since=${now - 3_600_000}&until=${now + 3_600_000}`
    );
    // The stats are inline in the envelope: their keys are the served ones, no more and no fewer.
    const inline = (schema('WebhookStatsEnvelope').properties as any).data.properties.stats;
    expect(Object.keys(stats.data.stats).sort()).toEqual(Object.keys(inline.properties).sort());
    expect(inline.required.slice().sort()).toEqual(Object.keys(inline.properties).sort());
    expect(stats.data.stats.failed).toBe(1);
    const grouped = await fits(
      'WebhookGroupStatsEnvelope',
      'GET',
      `/webhooks/stats?groupBy=webhook&since=${now - 3_600_000}&until=${now + 3_600_000}`
    );
    const mine = grouped.data.groups.find((g: { webhookId: string }) => g.webhookId === hookId);
    expect(mine.failed).toBe(stats.data.stats.failed);
    await fits('WebhookRetryFailedEnvelope', 'POST', `/webhooks/${hookId}/deliveries/retry`, {
      status: 'failed',
    });
    // The retried delivery is pending, so the following test (which retries one) fails it again first.
    const claimed = await f.store.webhooks.claimDue(CLAIM);
    await f.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      { ...POLICY, maxAttempts: 1 }
    );
  });

  test('the issues and a status change, as they are served', async () => {
    const page = await fits('WebhookIssuesPage', 'GET', '/webhooks/issues');
    expect(page.data.issues.length).toBeGreaterThan(0);
    for (const issue of page.data.issues) expect(keysFit(issue, 'WebhookIssue')).toEqual([]);
    const changed = await fits(
      'WebhookIssueEnvelope',
      'PUT',
      `/webhooks/issues/${page.data.issues[0].id}`,
      { status: 'acknowledged' }
    );
    expect(keysFit(changed.data.issue, 'WebhookIssue')).toEqual([]);
    expect(Object.keys(schema('WebhookIssueSet').properties ?? {})).toEqual(['status']);
  });

  test('a destination and its list, as they are served', async () => {
    const created = await fits('DestinationEnvelope', 'POST', '/webhooks/destinations', {
      name: 'Billing',
      kind: 'http',
      url: 'https://billing.example.com/in',
    });
    const id = created.data.destination.id;
    expect(keysFit(created.data.destination, 'Destination')).toEqual([]);
    const list = await fits('DestinationsList', 'GET', '/webhooks/destinations');
    for (const one of list.data.destinations) expect(keysFit(one, 'Destination')).toEqual([]);
    await fits('DestinationEnvelope', 'PATCH', `/webhooks/destinations/${id}`, {
      name: 'Payments',
    });
    const made = await fits('WebhookEnvelope', 'POST', '/webhooks', {
      destinationId: id,
      events: ['job.completed'],
    });
    expect(made.data.webhook.destinationId).toBe(id);
    await fits('Ok', 'DELETE', `/webhooks/${made.data.webhook.id}`);
    await fits('Ok', 'DELETE', `/webhooks/destinations/${id}`);
    expect(Object.keys(schema('DestinationCreate').properties ?? {}).sort()).toEqual([
      'kind',
      'name',
      'target',
      'url',
    ]);
    expect(Object.keys(schema('DestinationPatch').properties ?? {}).sort()).toEqual([
      'name',
      'target',
      'url',
    ]);
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
      'dedupe',
      'delayMs',
      'description',
      'destination',
      'destinationId',
      'enabled',
      'events',
      'filter',
      'name',
      'queue',
      'secret',
      'shape',
      'target',
      'url',
    ]);
    // The edit body is the create body's rules and events: nothing that is fixed at creation.
    expect(Object.keys(schema('WebhookPatch').properties ?? {}).sort()).toEqual([
      'dedupe',
      'delayMs',
      'description',
      'events',
      'filter',
      'name',
      'shape',
    ]);
    for (const name of ['Webhook', 'WebhookDelivery', 'WebhookAttempt']) {
      expect(Object.keys(schema(name).properties ?? {}), name).not.toContain('secret');
    }
  });
});
