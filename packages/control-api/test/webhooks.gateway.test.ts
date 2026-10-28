import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { routeJobId } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import {
  addHook,
  CLAIM,
  hookSource,
  KEY,
  outcome,
  POLICY,
  send,
} from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const HOUR = 3_600_000;
const ONCE = { ...POLICY, maxAttempts: 1 };

describeDb(
  'webhook routes as an event gateway: queue routes, the feed, stats and bulk retry',
  () => {
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

    const route = async (to: string, extra: Record<string, unknown> = {}) =>
      api.call('POST', '/webhooks', {
        destination: 'queue',
        target: to,
        source: await hookSource(f),
        ...extra,
      });
    const ids = (answer: { body: Record<string, any> }) =>
      answer.body.data.deliveries.map((d: { id: string }) => d.id);

    /** Two http routes and three requests: six deliveries, all claimed (so `sending`). `of(hook, 1)` is the first request's. */
    async function seed() {
      const a = await addHook(f);
      const b = await addHook(f);
      const requests: string[] = [];
      for (const id of [1, 2, 3]) {
        requests.push(await send(f.t, { id }));
        f.t.clock.advance(1_000);
      }
      const claimed = await f.store.webhooks.claimDue(CLAIM);
      expect(claimed).toHaveLength(6);
      const of = (hook: { id: string }, n: number) =>
        claimed.find((c) => c.webhookId === hook.id && c.requestId === requests[n - 1])!;
      return { a, b, of, requests };
    }
    const record = (...results: Array<ReturnType<typeof outcome>>) =>
      f.store.webhooks.record(results, ONCE);

    test('a route needs a source, and the job events are gone from its body', async () => {
      const url = 'https://hooks.example.com/in';
      expect((await api.call('POST', '/webhooks', { url })).status).toBe(400);
      expect(
        (await api.call('POST', '/webhooks', { url, events: ['request.received'] })).status
      ).toBe(400);
      const source = await hookSource(f);
      const made = await api.call('POST', '/webhooks', { url, source });
      expect(made.status).toBe(201);
      expect(made.body.data.webhook).toMatchObject({
        destination: 'http',
        url,
        target: null,
        source,
      });
    });

    test('a queue route is made without an address, and a viewer reads its target in full', async () => {
      const made = await route('refunds');
      expect(made.status).toBe(201);
      expect(made.body.data.webhook).toMatchObject({
        destination: 'queue',
        url: '',
        urlRedacted: false,
        target: 'refunds',
      });
      await addHook(f, { url: 'https://hooks.example.com/secret-path-token' });
      const list = await api.asViewer('GET', '/webhooks');
      const [queued, http] = list.body.data.webhooks;
      expect(queued).toMatchObject({ destination: 'queue', target: 'refunds', url: '' });
      expect(http).toMatchObject({ destination: 'http', urlRedacted: true, target: null });
      expect(JSON.stringify(list.body)).not.toContain('secret-path-token');
    });

    test('a route needs the fields of its destination', async () => {
      const source = await hookSource(f);
      const noTarget = await api.call('POST', '/webhooks', { destination: 'queue', source });
      expect(noTarget.status).toBe(400);
      const noUrl = await api.call('POST', '/webhooks', { source });
      expect(noUrl.status).toBe(400);
      const both = await api.call('POST', '/webhooks', {
        destination: 'queue',
        url: 'https://hooks.example.com/in',
        target: 'b',
        source,
      });
      expect(both.status).toBe(400);
      expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(0);
    });

    test('the feed pages across routes by one cursor, and filters by route and by status', async () => {
      const { a, of, requests } = await seed();
      await record(outcome(of(a, 1), { ok: true }), outcome(of(a, 2), { ok: false }));

      const first = await api.call('GET', '/webhooks/deliveries?limit=4');
      expect(first.status).toBe(200);
      expect(first.body.data.deliveries).toHaveLength(4);
      expect(
        new Set(first.body.data.deliveries.map((d: { webhookId: string }) => d.webhookId)).size
      ).toBe(2);
      const second = await api.call(
        'GET',
        `/webhooks/deliveries?limit=4&before=${first.body.data.next}`
      );
      expect(second.body.data.deliveries).toHaveLength(2);
      expect(second.body.data.next).toBeNull();
      expect(new Set([...ids(first), ...ids(second)]).size).toBe(6);
      // Newest first across the whole feed.
      const all = [...ids(first), ...ids(second)].map(Number);
      expect(all).toEqual([...all].sort((x, y) => y - x));

      const mine = await api.call('GET', `/webhooks/deliveries?webhook=${a.id}`);
      expect(mine.body.data.deliveries).toHaveLength(3);
      const failed = await api.call('GET', '/webhooks/deliveries?status=failed');
      expect(failed.body.data.deliveries.map((d: { requestId: string }) => d.requestId)).toEqual([
        requests[1],
      ]);
      const nothing = await api.call('GET', `/webhooks/deliveries?since=${f.t.clock.now() + HOUR}`);
      expect(nothing.body.data.deliveries).toEqual([]);
      expect((await api.asViewer('GET', '/webhooks/deliveries')).status).toBe(200);
      expect((await api.call('GET', '/webhooks/deliveries?status=bogus')).status).toBe(400);
    });

    test('a delivered queue route names the job it made, and nothing else does', async () => {
      const made = (await route('refunds')).body.data.webhook;
      const http = await addHook(f);
      await send(f.t, { id: 'o-1' });
      const claimed = await f.store.webhooks.claimDue(CLAIM);
      await record(...claimed.map((c) => outcome(c, { ok: true, statusCode: null })));

      const feed = await api.call('GET', '/webhooks/deliveries');
      for (const d of feed.body.data.deliveries) {
        expect(d.routedJobId).toBe(d.webhookId === made.id ? routeJobId(d.id) : null);
      }
      expect(
        feed.body.data.deliveries.some((d: { routedJobId: string | null }) => d.routedJobId)
      ).toBe(true);
      const own = await api.call('GET', `/webhooks/${http.id}/deliveries`);
      expect(own.body.data.deliveries.map((d: { routedJobId: unknown }) => d.routedJobId)).toEqual([
        null,
      ]);
      const queued = await api.call('GET', `/webhooks/${made.id}/deliveries`);
      expect(queued.body.data.deliveries[0].routedJobId).toBe(
        routeJobId(queued.body.data.deliveries[0].id)
      );
    });

    test('stats match a hand count, and a window over seven days is refused', async () => {
      const { a, of } = await seed();
      await record(
        outcome(of(a, 1), { ok: true }),
        outcome(of(a, 2), { ok: true }),
        outcome(of(a, 3), { ok: false })
      );
      const now = f.t.clock.now();
      const window = `since=${now - HOUR}&until=${now + HOUR}`;
      const answer = await api.asViewer('GET', `/webhooks/stats?${window}`);
      expect(answer.status).toBe(200);
      const { stats } = answer.body.data;
      expect(stats).toMatchObject({ delivered: 2, failed: 1, pending: 3, backlog: 3 });
      expect(stats.failureRatio).toBeCloseTo(1 / 3);
      expect(stats.buckets).toHaveLength(24);
      const one = await api.call('GET', `/webhooks/stats?${window}&webhook=${a.id}&buckets=4`);
      expect(one.body.data.stats).toMatchObject({ delivered: 2, failed: 1, pending: 0 });
      expect(one.body.data.stats.buckets).toHaveLength(4);

      expect(
        (await api.call('GET', `/webhooks/stats?since=${now - 8 * 24 * HOUR}&until=${now}`)).status
      ).toBe(400);
      expect((await api.call('GET', '/webhooks/stats')).status).toBe(400);
    });

    test("a bulk retry puts back only that webhook's failed deliveries, newest first, at most `limit`", async () => {
      const { a, b, of, requests } = await seed();
      await record(
        ...[1, 2, 3].flatMap((n) => [
          outcome(of(a, n), { ok: false }),
          outcome(of(b, n), { ok: false }),
        ])
      );
      const retry = (id: string, body: unknown) =>
        api.call('POST', `/webhooks/${id}/deliveries/retry`, body);
      const failedOf = async (id: string) =>
        (await api.call('GET', `/webhooks/${id}/deliveries?status=failed`)).body.data.deliveries
          .length;

      const some = await retry(a.id, { status: 'failed', limit: 2 });
      expect(some.status).toBe(200);
      expect(some.body.data.retried).toBe(2);
      expect(await failedOf(a.id)).toBe(1);
      // The newest ones went back; another webhook's failures were not touched.
      const pending = await api.call('GET', `/webhooks/${a.id}/deliveries?status=pending`);
      expect(pending.body.data.deliveries.map((d: { requestId: string }) => d.requestId)).toEqual([
        requests[2],
        requests[1],
      ]);
      expect(await failedOf(b.id)).toBe(3);

      expect((await retry(a.id, { status: 'failed' })).body.data.retried).toBe(1);
      expect((await retry(a.id, { status: 'failed' })).body.data.retried).toBe(0);
    });

    test('a bulk retry needs an operator, a known webhook and the body it names', async () => {
      const { a } = await seed();
      const path = `/webhooks/${a.id}/deliveries/retry`;
      expect((await api.asViewer('POST', path, { status: 'failed' })).status).toBe(403);
      expect(
        (await api.call('POST', '/webhooks/nope/deliveries/retry', { status: 'failed' })).status
      ).toBe(404);
      for (const body of [
        {},
        { status: 'pending' },
        { status: 'failed', limit: 501 },
        { status: 'failed', x: 1 },
      ]) {
        expect((await api.call('POST', path, body)).status, JSON.stringify(body)).toBe(400);
      }
    });
  }
);
