import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome } from './webhookHelpers';

const ONCE = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000 };
const MINUTE = 60_000;
const WINDOW = { since: START, until: START + 10 * MINUTE };

describeDb('webhooks: stats for every route at once', () => {
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

  test('every route is in the answer, in id order, with zeros when it had no events', async () => {
    const hooks = [await addHook(t), await addHook(t), await addHook(t)];
    const answer = await t.store.webhooks.statsByWebhook(WINDOW);
    expect(answer).toMatchObject({ since: WINDOW.since, until: WINDOW.until });
    expect(answer.groups.map((g) => g.webhookId)).toEqual(hooks.map((h) => h.id).sort());
    for (const group of answer.groups) {
      expect(group).toMatchObject({
        delivered: 0,
        failed: 0,
        pending: 0,
        failureRatio: null,
        backlog: 0,
        oldestPendingAt: null,
      });
      expect(group.buckets).toHaveLength(24);
      expect(group.buckets.every((b) => b.delivered + b.failed + b.pending === 0)).toBe(true);
    }
  });

  test('the counts, the ratio, the backlog and the trend equal the single-route read', async () => {
    const [a, b] = [await addHook(t), await addHook(t)];
    const quiet = await addHook(t, { queue: 'other' });
    for (const job of ['j1', 'j2', 'j3', 'j4']) {
      await journal(t, [event('pushed', 'q', job)]);
      t.clock.advance(MINUTE);
    }
    const claimed = await t.store.webhooks.claimDue({ ...CLAIM, limit: 6 });
    expect(claimed).toHaveLength(6);
    // A mix: some delivered, some failed, and the rest still sending (the 2 deliveries of j4 stay pending).
    await t.store.webhooks.record(
      claimed.map((c, index) => outcome(c, { ok: index % 3 !== 0 })),
      ONCE
    );
    const all = await t.store.webhooks.statsByWebhook({ ...WINDOW, buckets: 10 });
    expect(all.groups.map((g) => g.webhookId)).toContain(quiet.id);
    for (const hook of [a, b, quiet]) {
      const one = await t.store.webhooks.stats({ ...WINDOW, buckets: 10, webhook: hook.id });
      const group = all.groups.find((g) => g.webhookId === hook.id)!;
      expect(group, hook.id).toMatchObject({
        delivered: one.delivered,
        failed: one.failed,
        pending: one.pending,
        failureRatio: one.failureRatio,
        backlog: one.backlog,
        oldestPendingAt: one.oldestPendingAt,
      });
      expect(group.buckets).toEqual(
        one.buckets.map((s) => ({
          from: s.from,
          delivered: s.delivered,
          failed: s.failed,
          pending: s.pending,
        }))
      );
    }
    const total = all.groups.reduce((sum, g) => sum + g.delivered + g.failed + g.pending, 0);
    expect(total).toBe(8);
    expect(all.groups.find((g) => g.webhookId === quiet.id)!.pending).toBe(0);
  });

  test('a window outside the events counts nothing but still lists the routes', async () => {
    await addHook(t);
    await journal(t, [event('pushed', 'q', 'j1')]);
    const later = { since: START + 60 * MINUTE, until: START + 70 * MINUTE };
    const answer = await t.store.webhooks.statsByWebhook(later);
    expect(answer.groups).toHaveLength(1);
    expect(answer.groups[0]).toMatchObject({ delivered: 0, failed: 0, pending: 0 });
    // What is waiting now is not a window's number.
    expect(answer.groups[0]!.backlog).toBe(1);
  });

  test('the window is checked as the single-route read checks it', async () => {
    const refused = (query: Parameters<typeof t.store.webhooks.statsByWebhook>[0]) =>
      t.store.webhooks.statsByWebhook(query).catch((e: unknown) => e);
    for (const [query, option] of [
      [{ since: -1, until: 5 }, 'since'],
      [{ since: 5, until: 5 }, 'until'],
      [{ since: 0, until: 8 * 24 * 60 * MINUTE }, 'until'],
      [{ ...WINDOW, buckets: 0 }, 'buckets'],
      [{ ...WINDOW, buckets: 169 }, 'buckets'],
    ] as const) {
      const error = await refused(query);
      expect(error, JSON.stringify(query)).toBeInstanceOf(UnsupportedOptionError);
      expect((error as UnsupportedOptionError).option).toBe(option);
    }
  });
});
