import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addHook, CLAIM, KEY, outcome, send } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const HOUR = 3_600_000;
const ONCE = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000 };

describeDb('webhook routes: stats for every route at once (groupBy=webhook)', () => {
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

  const window = () => `since=${f.t.clock.now() - HOUR}&until=${f.t.clock.now() + HOUR}`;
  const grouped = (query = '') =>
    api.call('GET', `/webhooks/stats?groupBy=webhook&${window()}${query}`);

  test('every route is an entry, a quiet one with zeros, and the totals agree with the single-route read', async () => {
    const busy = await addHook(f);
    const other = (await f.store.sources.create({ name: 'other' }, 'tester')).id;
    const quiet = await addHook(f, { source: other });
    await send(f.t, { id: 1 });
    await send(f.t, { id: 2 });
    const claimed = await f.store.webhooks.claimDue(CLAIM);
    await f.store.webhooks.record(
      claimed.map((c, index) => outcome(c, { ok: index === 0 })),
      ONCE
    );
    const answer = await grouped('&buckets=6');
    expect(answer.status).toBe(200);
    const { groups, bucketMs } = answer.body.data;
    expect(bucketMs).toBe(Math.ceil((2 * HOUR) / 6));
    expect(groups.map((g: { webhookId: string }) => g.webhookId).sort()).toEqual(
      [busy.id, quiet.id].sort()
    );
    const one = (await api.call('GET', `/webhooks/stats?${window()}&buckets=6&webhook=${busy.id}`))
      .body.data.stats;
    expect(groups.find((g: { webhookId: string }) => g.webhookId === busy.id)).toMatchObject({
      delivered: 1,
      failed: 1,
      failureRatio: 0.5,
    });
    expect(one).toMatchObject({ delivered: 1, failed: 1 });
    expect(groups.find((g: { webhookId: string }) => g.webhookId === quiet.id)).toMatchObject({
      delivered: 0,
      failed: 0,
      pending: 0,
      failureRatio: null,
    });
  });

  test('a viewer reads it, and it carries no route name, address or secret', async () => {
    await addHook(f, {
      name: 'private-looking-name',
      url: 'https://hooks.example.com/in?token=private-path-token',
    });
    const answer = await api.asViewer('GET', `/webhooks/stats?groupBy=webhook&${window()}`);
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain('private');
  });

  test('groupBy takes only "webhook", cannot be combined with a route, and still needs a window', async () => {
    const refused = async (query: string) =>
      (await api.call('GET', `/webhooks/stats?${query}`)).status;
    expect(await refused(`groupBy=queue&${window()}`)).toBe(400);
    expect(await refused(`groupBy=webhook&webhook=w1&${window()}`)).toBe(400);
    expect(await refused('groupBy=webhook')).toBe(400);
    expect(await refused(`groupBy=webhook&since=0&until=${9 * 24 * HOUR}`)).toBe(400);
    expect(await refused(`groupBy=webhook&${window()}&buckets=169`)).toBe(400);
  });

  test('without groupBy the answer is still the window totals', async () => {
    const answer = await api.call('GET', `/webhooks/stats?${window()}`);
    expect(Object.keys(answer.body.data)).toEqual(['stats']);
  });
});
