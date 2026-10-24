import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  addHook,
  CLAIM,
  hookSource,
  KEY,
  outcome,
  POLICY,
  SECRET,
  send,
} from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('webhook delivery routes', () => {
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

  const hook = () => addHook(f, { secret: SECRET });
  const deliveries = (id: string, query = '') =>
    api.call('GET', `/webhooks/${id}/deliveries${query}`);

  /** Fails every delivery of the webhook for good: one attempt allowed, answered 500. */
  async function failAll(): Promise<void> {
    const claimed = await f.store.webhooks.claimDue(CLAIM);
    await f.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      { ...POLICY, maxAttempts: 1 }
    );
  }

  test('a test event is queued, answers 202 with the delivery, and is sent by the next tick', async () => {
    const { id } = await hook();
    const answer = await api.call('POST', `/webhooks/${id}/test`);
    expect(answer.status).toBe(202);
    expect(answer.body.data.delivery).toMatchObject({
      webhookId: id,
      event: 'webhook.test',
      status: 'pending',
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      history: [],
    });
    // Only the test is waiting: no request was accepted.
    const claimed = await f.store.webhooks.claimDue(CLAIM);
    expect(claimed.map((c) => c.event)).toEqual(['webhook.test']);
  });

  test('a test event for an unknown webhook is 404, and for a disabled one 409', async () => {
    expect((await api.call('POST', '/webhooks/nope/test')).status).toBe(404);
    const { id } = await hook();
    await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: false });
    const refused = await api.call('POST', `/webhooks/${id}/test`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('webhook_disabled');
  });

  test('the history is newest first, pages by a cursor, and filters by status', async () => {
    const { id } = await hook();
    const requests: string[] = [];
    for (let i = 0; i < 5; i++) requests.push(await send(f.t, { i }));
    const ids = (page: { body: any }) =>
      page.body.data.deliveries.map((d: { requestId: string }) => d.requestId);
    const first = await deliveries(id, '?limit=2');
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual([requests[4], requests[3]]);
    expect(typeof first.body.data.next).toBe('string');
    const second = await deliveries(id, `?limit=2&before=${first.body.data.next}`);
    expect(ids(second)).toEqual([requests[2], requests[1]]);
    const last = await deliveries(id, `?limit=2&before=${second.body.data.next}`);
    expect(ids(last)).toEqual([requests[0]]);
    expect(last.body.data.next).toBeNull();
    expect((await deliveries(id, '?status=failed')).body.data.deliveries).toEqual([]);
    expect((await deliveries(id, '?status=pending')).body.data.deliveries).toHaveLength(5);
  });

  test('a bad limit, cursor or status is 400, and an unknown webhook is 404', async () => {
    const { id } = await hook();
    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=x',
      '?before=abc',
      '?before=0',
      '?status=lost',
    ]) {
      expect((await deliveries(id, query)).status, query).toBe(400);
    }
    expect((await deliveries('nope')).status).toBe(404);
  });

  test('a delivery shows its attempts, status and last error, in the sender fixed words', async () => {
    const { id } = await hook();
    await send(f.t);
    await failAll();
    const [delivery] = (await deliveries(id)).body.data.deliveries;
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatusCode: 500,
      lastError: 'receiver answered 500',
      history: [{ attempt: 1, statusCode: 500, error: 'receiver answered 500' }],
    });
    expect(delivery.finishedAt).toBeGreaterThan(0);
    // The history names no URL, no secret and no body.
    const text = JSON.stringify(delivery);
    expect(text).not.toContain('hooks.example.com');
    expect(text).not.toContain(SECRET);
  });

  test('retrying a failed delivery puts it back with a fresh budget; anything else is refused', async () => {
    const { id } = await hook();
    await send(f.t);
    await failAll();
    const [failed] = (await deliveries(id)).body.data.deliveries;

    const retried = await api.call('POST', `/webhooks/${id}/deliveries/${failed.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.data.delivery).toMatchObject({ id: failed.id, status: 'pending' });

    const again = await api.call('POST', `/webhooks/${id}/deliveries/${failed.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'delivery_not_failed',
      details: { status: 'pending' },
    });

    expect((await api.call('POST', `/webhooks/${id}/deliveries/999999/retry`)).status).toBe(404);
    expect((await api.call('POST', `/webhooks/${id}/deliveries/abc/retry`)).status).toBe(400);
    expect((await api.call('POST', `/webhooks/nope/deliveries/${failed.id}/retry`)).status).toBe(
      404
    );
  });

  test('every mutation is audited by webhook id and never by address or secret', async () => {
    const created = await api.call('POST', '/webhooks', {
      url: 'https://hooks.example.com/services/private-path-token',
      source: await hookSource(f),
      secret: SECRET,
    });
    const { id } = created.body.data.webhook;
    await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: false });
    await api.call('PUT', `/webhooks/${id}/enabled`, { enabled: true });
    await api.call('POST', `/webhooks/${id}/test`);
    await api.call('DELETE', `/webhooks/${id}`);
    await api.call('POST', '/webhooks', {
      url: 'http://bad.example.com/',
      source: await hookSource(f),
      secret: SECRET,
    });
    await api.asViewer('DELETE', `/webhooks/${id}`);

    const rows = [...(await f.store.audit.list({ limit: 100 })).items].reverse();
    expect(rows.map((row) => [row.action, row.status])).toEqual([
      ['POST /webhooks', 201],
      ['PUT /webhooks/:id/enabled', 200],
      ['PUT /webhooks/:id/enabled', 200],
      ['POST /webhooks/:id/test', 202],
      ['DELETE /webhooks/:id', 200],
      ['POST /webhooks', 400],
      ['DELETE /webhooks/:id', 403],
    ]);
    expect(rows[0]!.target).toBe(`webhook=${id}`);
    expect(rows[1]!.target).toBe(`id=${id}`);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('private-path-token');
    expect(everything).not.toContain('hooks.example.com');
  });
});
