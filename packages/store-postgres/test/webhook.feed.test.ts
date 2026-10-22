import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome, rawDeliveries } from './webhookHelpers';

const ONCE = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000 };
const MINUTE = 60_000;

describeDb('webhooks: the feed across routes, bulk retry and stats', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, random: () => 0.5 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** Two webhooks and three events a minute apart (jobs j1, j2, j3): six deliveries, all claimed. */
  async function seed() {
    const a = await addHook(t);
    const b = await addHook(t);
    for (const job of ['j1', 'j2', 'j3']) {
      await journal(t, [event('pushed', 'q', job)]);
      t.clock.advance(MINUTE);
    }
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    expect(claimed).toHaveLength(6);
    const of = (hook: { id: string }, job: string) =>
      claimed.find((c) => c.webhookId === hook.id && c.jobId === job)!;
    return { a, b, of };
  }

  /** Records `result` for the delivery of `job` to `hook`, an attempt at the minute its event was. */
  const finish = (
    claimed: Awaited<ReturnType<typeof seed>>['of'],
    hook: { id: string },
    job: string,
    result: Parameters<typeof outcome>[1],
    ms: number
  ) => {
    const minute = Number(job.slice(1)) - 1;
    return t.store.webhooks.record(
      [outcome(claimed(hook, job), { ...result, at: START + minute * MINUTE + 1_000 }, ms)],
      ONCE
    );
  };

  test('deliveriesAll pages every webhook newest first by one cursor', async () => {
    await seed();
    const first = await t.store.webhooks.deliveriesAll({ limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.next).toBe(first.items[3]!.id);
    const second = await t.store.webhooks.deliveriesAll({ limit: 4, before: first.next! });
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    const ids = [...first.items, ...second.items].map((d) => Number(d.id));
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect(new Set(ids).size).toBe(6);
  });

  test('it filters by status, webhook and the time of the event', async () => {
    const { a, b, of } = await seed();
    await finish(of, a, 'j1', { ok: true }, 10);
    await finish(of, a, 'j2', { ok: false }, 10);
    await finish(of, b, 'j3', { ok: false }, 10);
    const feed = t.store.webhooks;

    expect((await feed.deliveriesAll({ status: 'failed' })).items).toHaveLength(2);
    expect((await feed.deliveriesAll({ status: 'delivered' })).items).toHaveLength(1);
    expect((await feed.deliveriesAll({ status: 'sending' })).items).toHaveLength(3);
    expect((await feed.deliveriesAll({ webhook: a.id })).items.map((d) => d.webhookId)).toEqual([
      a.id,
      a.id,
      a.id,
    ]);
    expect((await feed.deliveriesAll({ webhook: a.id, status: 'failed' })).items).toHaveLength(1);
    // Events at START, START + 1 min and START + 2 min: a window is half open, [since, until).
    expect((await feed.deliveriesAll({ since: START + MINUTE })).items).toHaveLength(4);
    expect((await feed.deliveriesAll({ until: START + MINUTE })).items).toHaveLength(2);
    expect(
      (await feed.deliveriesAll({ since: START + MINUTE, until: START + 2 * MINUTE })).items
    ).toHaveLength(2);
    expect((await feed.deliveriesAll({ webhook: 'nope' })).items).toEqual([]);
  });

  test('a bad limit, status, cursor or time is refused by name', async () => {
    const feed = t.store.webhooks;
    const refused = async (query: Parameters<typeof feed.deliveriesAll>[0], option: string) => {
      const error = await feed.deliveriesAll(query).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect((error as UnsupportedOptionError).option).toBe(option);
    };
    await refused({ limit: 0 }, 'limit');
    await refused({ limit: 201 }, 'limit');
    await refused({ status: 'done' as never }, 'status');
    await refused({ before: 'x' }, 'before');
    await refused({ since: -1 }, 'since');
    await refused({ until: 1.5 }, 'until');
  });

  test('bulk retry puts back only the failed ones of that webhook, newest first, at most limit', async () => {
    const { a, b, of } = await seed();
    for (const job of ['j1', 'j2', 'j3']) await finish(of, a, job, { ok: false }, 10);
    await finish(of, b, 'j1', { ok: false }, 10);
    await finish(of, b, 'j2', { ok: true }, 10);
    const feed = t.store.webhooks;

    expect(await feed.retryFailed(a.id, { limit: 2 })).toEqual({ retried: 2 });
    const rows = await rawDeliveries(t);
    const mine = rows.filter((r) => r.webhook_id === a.id);
    expect(mine.filter((r) => r.status === 'pending').map((r) => r.job_id)).toEqual(['j2', 'j3']);
    expect(mine.find((r) => r.job_id === 'j1')!.status).toBe('failed');
    // A full budget from here: attempt numbers go on rising.
    expect(mine.filter((r) => r.status === 'pending').every((r) => r.attempt_base === 1)).toBe(
      true
    );
    // Nothing of the other webhook moved.
    expect(rows.filter((r) => r.webhook_id === b.id).map((r) => r.status)).toEqual([
      'failed',
      'delivered',
      'sending',
    ]);

    const oldest = mine.find((r) => r.job_id === 'j1')!;
    expect(await feed.retryFailed(a.id, { before: oldest.id })).toEqual({ retried: 0 });
    expect(await feed.retryFailed(a.id)).toEqual({ retried: 1 });
    expect(await feed.retryFailed(a.id)).toEqual({ retried: 0 });
    expect(await feed.retryFailed('nope')).toBeNull();
    const again = await feed.claimDue(CLAIM);
    expect(again.filter((c) => c.webhookId === a.id).map((c) => c.attempt)).toEqual([2, 2, 2]);
  });

  test('bulk retry refuses a limit over 500 or a bad cursor', async () => {
    const a = await addHook(t);
    for (const options of [{ limit: 0 }, { limit: 501 }, { before: 'x' }]) {
      expect(
        await t.store.webhooks.retryFailed(a.id, options).catch((e: unknown) => e)
      ).toBeInstanceOf(UnsupportedOptionError);
    }
  });

  test('stats match a hand count: outcomes, attempts, backlog and latency by slice', async () => {
    const { a, b, of } = await seed();
    await finish(of, a, 'j1', { ok: true }, 10);
    await finish(of, a, 'j2', { ok: true }, 30);
    await finish(of, a, 'j3', { ok: false }, 50);
    await finish(of, b, 'j1', { ok: true }, 20);
    // A timeout: no status came back, so it has no receiver latency.
    await finish(of, b, 'j2', { ok: false, statusCode: null, error: 'timed out' }, 900);
    // b's j3 is left being sent.

    const stats = await t.store.webhooks.stats({
      since: START,
      until: START + 3 * MINUTE,
      buckets: 3,
    });
    expect(stats).toMatchObject({
      bucketMs: MINUTE,
      delivered: 3,
      failed: 2,
      pending: 1,
      failureRatio: 2 / 5,
      avgAttempts: 1,
      backlog: 1,
      oldestPendingAt: START + 2 * MINUTE,
    });
    expect(stats.latency).toEqual({ avgMs: 27.5, p95Ms: 47, maxMs: 50 });
    expect(stats.buckets).toEqual([
      { from: START, delivered: 2, failed: 0, pending: 0, avgLatencyMs: 15, p95LatencyMs: 19.5 },
      {
        from: START + MINUTE,
        delivered: 1,
        failed: 1,
        pending: 0,
        avgLatencyMs: 30,
        p95LatencyMs: 30,
      },
      {
        from: START + 2 * MINUTE,
        delivered: 0,
        failed: 1,
        pending: 1,
        avgLatencyMs: 50,
        p95LatencyMs: 50,
      },
    ]);

    const mine = await t.store.webhooks.stats({
      since: START,
      until: START + 3 * MINUTE,
      webhook: a.id,
      buckets: 1,
    });
    expect(mine).toMatchObject({ delivered: 2, failed: 1, pending: 0, backlog: 0 });
    expect(mine.latency).toEqual({ avgMs: 30, p95Ms: 48, maxMs: 50 });
  });

  test('an empty window is zeros and nulls, and a bad window is refused', async () => {
    const stats = await t.store.webhooks.stats({ since: START, until: START + MINUTE });
    expect(stats).toMatchObject({
      delivered: 0,
      failed: 0,
      pending: 0,
      failureRatio: null,
      avgAttempts: null,
      backlog: 0,
      oldestPendingAt: null,
      latency: null,
    });
    expect(stats.buckets).toHaveLength(24);
    const refused = (query: Parameters<typeof t.store.webhooks.stats>[0]) =>
      t.store.webhooks.stats(query).catch((e: unknown) => e);
    expect(await refused({ since: START, until: START })).toBeInstanceOf(UnsupportedOptionError);
    expect(await refused({ since: START, until: START + 8 * 86_400_000 })).toBeInstanceOf(
      UnsupportedOptionError
    );
    expect(await refused({ since: START, until: START + MINUTE, buckets: 0 })).toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
