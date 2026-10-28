import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addHook, CLAIM, KEY, outcome, send } from '../../store-postgres/test/webhookHelpers';
import { deploymentHarness } from './deploymentHarness';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

/** One attempt per delivery, and the pause comes at four in a row (the first alert at two). */
const POLICY = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000, disableAfter: 4 };
const PRIVATE_URL = 'https://hooks.example.com/in?token=private-path-token';

describeDb('webhook routes: issues (D13)', () => {
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
  const { open, deployment, codes } = deploymentHarness(() => f);

  let n = 0;
  /** Sends one event through to a recorded result. */
  const run = async (ok: boolean, limit = 1) => {
    n += 1;
    await send(f.t, { n });
    f.t.clock.advance(1);
    const claimed = await f.store.webhooks.claimDue({ ...CLAIM, limit });
    await f.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok })),
      POLICY
    );
  };
  const fails = async (count: number) => {
    for (let i = 0; i < count; i += 1) await run(false);
  };
  const issues = async (query = '') => (await api.call('GET', `/webhooks/issues${query}`)).body;
  const set = (id: string, status: string) => api.call('PUT', `/webhooks/issues/${id}`, { status });

  test('with nothing failing the list is empty and every count is zero', async () => {
    const answer = await api.call('GET', '/webhooks/issues');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      ok: true,
      data: {
        issues: [],
        next: null,
        counts: { open: 0, acknowledged: 0, resolved: 0, ignored: 0 },
      },
    });
  });

  test('a failing route is an open issue that carries the route name and streak', async () => {
    const hook = await addHook(f, { name: 'Orders to billing' });
    await fails(2);
    const { data } = await issues();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toMatchObject({
      webhookId: hook.id,
      webhookName: 'Orders to billing',
      status: 'open',
      kind: 'delivery_failed',
      updatedBy: null,
      consecutiveFailures: 2,
      alertLevel: 1,
      pausedBy: null,
    });
    expect(data.counts).toEqual({ open: 1, acknowledged: 0, resolved: 0, ignored: 0 });
    expect((await issues('?status=resolved')).data.issues).toEqual([]);
    expect((await issues(`?webhook=${hook.id}`)).data.issues).toHaveLength(1);
    expect((await issues('?webhook=nobody')).data.issues).toEqual([]);
  });

  test('an operator acknowledges, ignores and reopens an issue; the counts follow', async () => {
    await addHook(f);
    await fails(1);
    const [issue] = (await issues()).data.issues;
    const acknowledged = await set(issue.id, 'acknowledged');
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.data.issue).toMatchObject({
      id: issue.id,
      status: 'acknowledged',
      updatedBy: expect.any(String),
    });
    expect((await issues()).data.issues).toEqual([]);
    expect((await issues('?status=acknowledged')).data.counts).toEqual({
      open: 0,
      acknowledged: 1,
      resolved: 0,
      ignored: 0,
    });
    expect((await set(issue.id, 'ignored')).body.data.issue.status).toBe('ignored');
    expect((await set(issue.id, 'open')).body.data.issue.status).toBe('open');
    expect((await issues()).data.issues.map((i: { id: string }) => i.id)).toEqual([issue.id]);
  });

  test('resolving by hand is history: it cannot be changed, and the next failure opens a new one', async () => {
    await addHook(f);
    await fails(1);
    const [issue] = (await issues()).data.issues;
    expect((await set(issue.id, 'resolved')).body.data.issue.status).toBe('resolved');
    const again = await set(issue.id, 'open');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'issue_resolved',
      details: { issueId: issue.id },
    });
    await fails(1);
    const { data } = await issues();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].id).not.toBe(issue.id);
    expect(data.counts).toMatchObject({ open: 1, resolved: 1 });
  });

  test('a delivery resolves the issue without anyone touching it', async () => {
    await addHook(f);
    await fails(1);
    await run(true);
    const { data } = await issues('?status=resolved');
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toMatchObject({ status: 'resolved', updatedBy: null });
  });

  test('an unknown id is a 404, a malformed id or status is a 400, and nothing is written', async () => {
    expect((await set('987654', 'acknowledged')).status).toBe(404);
    expect((await set('987654', 'acknowledged')).body.error.code).toBe('issue_not_found');
    expect((await set('abc', 'acknowledged')).status).toBe(400);
    for (const body of [{ status: 'closed' }, {}, { status: 'open', extra: 1 }]) {
      const answer = await api.call('PUT', '/webhooks/issues/1', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    for (const query of ['?status=closed', '?limit=0', '?limit=9999', '?before=abc']) {
      expect((await api.call('GET', `/webhooks/issues${query}`)).status, query).toBe(400);
    }
  });

  test('issues page newest first, with a cursor', async () => {
    const a = await addHook(f);
    const b = await addHook(f);
    const c = await addHook(f);
    await run(false, 3);
    const first = (await issues('?limit=2')).data;
    expect(first.issues).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const rest = (await issues(`?limit=2&before=${first.next}`)).data;
    expect(rest.next).toBeNull();
    const seen = [...first.issues, ...rest.issues].map((i: { webhookId: string }) => i.webhookId);
    expect(new Set(seen)).toEqual(new Set([a.id, b.id, c.id]));
    expect(seen).toHaveLength(3);
  });

  test('a viewer reads issues without who changed them, and cannot change one', async () => {
    await addHook(f);
    await fails(1);
    const [issue] = (await issues()).data.issues;
    await set(issue.id, 'acknowledged');
    const seen = (await api.asViewer('GET', '/webhooks/issues?status=acknowledged')).body.data;
    expect(seen.issues[0]).toMatchObject({ status: 'acknowledged', updatedBy: null });
    expect(
      (await api.asViewer('PUT', `/webhooks/issues/${issue.id}`, { status: 'open' })).status
    ).toBe(403);
    expect((await issues('?status=acknowledged')).data.issues[0].status).toBe('acknowledged');
  });

  test('the audit row of a change holds the issue id and nothing of the route', async () => {
    await addHook(f, { url: PRIVATE_URL, name: 'private-looking-name' });
    await fails(1);
    const [issue] = (await issues()).data.issues;
    await api.asViewer('PUT', `/webhooks/issues/${issue.id}`, { status: 'ignored' });
    await set(issue.id, 'ignored');
    const rows = [...(await f.store.audit.list({ limit: 100 })).items].reverse();
    const puts = rows.filter((row) => row.action === 'PUT /webhooks/issues/:id');
    expect(puts.map((row) => [row.status, row.target])).toEqual([
      [403, `id=${issue.id}`],
      [200, `id=${issue.id}`],
    ]);
    expect(JSON.stringify(rows)).not.toContain('private-path-token');
    expect(JSON.stringify(rows)).not.toContain('private-looking-name');
  });

  describe('Home warnings', () => {
    const warned = async () => codes(await deployment(open()));

    test('a route with a rising streak warns, and an ignored issue silences it', async () => {
      await addHook(f);
      await fails(2);
      expect(await warned()).toContain('webhook_failing');
      const [issue] = (await issues()).data.issues;
      await set(issue.id, 'ignored');
      expect(await warned()).not.toContain('webhook_failing');
      await set(issue.id, 'open');
      expect(await warned()).toContain('webhook_failing');
    });

    test('a route the failures paused warns; a pause by hand does not', async () => {
      const hook = await addHook(f);
      await fails(4);
      expect((await api.call('GET', `/webhooks/${hook.id}`)).body.data.webhook.pausedBy).toBe(
        'failures'
      );
      expect(await warned()).toContain('webhook_paused');
      await api.call('PUT', `/webhooks/${hook.id}/enabled`, { enabled: true });
      expect(await warned()).not.toContain('webhook_paused');
      await api.call('PUT', `/webhooks/${hook.id}/enabled`, { enabled: false, mode: 'hold' });
      const held = await api.call('GET', `/webhooks/${hook.id}`);
      expect(held.body.data.webhook.pausedBy).toBe('operator');
      expect(await warned()).not.toContain('webhook_paused');
    });
  });
});
