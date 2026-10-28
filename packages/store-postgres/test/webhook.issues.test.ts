import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { DEFAULT_WEBHOOK_KEEP_MS } from '../src/store/webhookRetention';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, KEY, outcome, send } from './webhookHelpers';

/** One attempt per delivery, so a failed attempt is a failed delivery; the pause is far off. */
const POLICY = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000, disableAfter: 100 };
const RETRYING = { ...POLICY, maxAttempts: 3 };

describeDb('webhooks: issues (migration 18)', () => {
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

  let n = 0;
  /** Sends one event through to a recorded result. */
  const run = async (ok: boolean, policy = POLICY) => {
    n += 1;
    await send(t, { id: `j${n}` });
    t.clock.advance(1);
    const claimed = await t.store.webhooks.claimDue({ ...CLAIM, limit: 1 });
    return t.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok })),
      policy
    );
  };
  const list = async (status: 'open' | 'acknowledged' | 'resolved' | 'ignored') =>
    (await t.store.webhooks.issues({ status })).items;

  test('a failed delivery opens one issue, and more failures add none', async () => {
    const hook = await addHook(t);
    expect(await list('open')).toEqual([]);
    await run(false);
    const [issue] = await list('open');
    expect(issue).toMatchObject({
      webhookId: hook.id,
      status: 'open',
      kind: 'delivery_failed',
      updatedBy: null,
    });
    expect(issue!.openedAt).toBe(issue!.updatedAt);
    await run(false);
    await run(false);
    expect(await list('open')).toEqual([issue!]);
    expect(await t.store.webhooks.issueCounts()).toEqual({
      open: 1,
      acknowledged: 0,
      resolved: 0,
      ignored: 0,
    });
  });

  test('an attempt that will be retried is not a failure yet', async () => {
    await addHook(t);
    await run(false, RETRYING);
    expect(await list('open')).toEqual([]);
  });

  test('a delivery resolves the live issue, whatever its status', async () => {
    await addHook(t);
    for (const status of ['open', 'acknowledged', 'ignored'] as const) {
      await run(false);
      if (status !== 'open') {
        const [issue] = await list('open');
        await t.store.webhooks.setIssueStatus(issue!.id, status, 'alice');
      }
      t.clock.advance(10);
      await run(true);
      expect(await t.store.webhooks.issueCounts()).toMatchObject({
        open: 0,
        acknowledged: 0,
        ignored: 0,
      });
    }
    const resolved = await list('resolved');
    expect(resolved).toHaveLength(3);
    expect(resolved.every((issue) => issue.updatedBy === null)).toBe(true);
  });

  test('an acknowledged or ignored issue survives more failures and is not duplicated', async () => {
    await addHook(t);
    await run(false);
    const [issue] = await list('open');
    await t.store.webhooks.setIssueStatus(issue!.id, 'ignored', 'alice');
    await run(false);
    await run(false);
    expect(await list('open')).toEqual([]);
    expect(await list('ignored')).toMatchObject([{ id: issue!.id, status: 'ignored' }]);
  });

  test('a resolve by hand is history: the next failure opens a new issue', async () => {
    await addHook(t);
    await run(false);
    const [first] = await list('open');
    t.clock.advance(5);
    const done = await t.store.webhooks.setIssueStatus(first!.id, 'resolved', 'alice');
    expect(done).toMatchObject({
      outcome: 'updated',
      issue: { status: 'resolved', updatedBy: 'alice', updatedAt: t.clock.now() },
    });
    await run(false);
    const [second] = await list('open');
    expect(second!.id).not.toBe(first!.id);
    expect(await t.store.webhooks.issueCounts()).toMatchObject({ open: 1, resolved: 1 });
  });

  test('a route held by an operator makes no issue', async () => {
    const hook = await addHook(t);
    n += 1;
    await send(t, { id: `j${n}` });
    const claimed = await t.store.webhooks.claimDue({ ...CLAIM, limit: 1 });
    await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    await t.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      POLICY
    );
    expect(await t.store.webhooks.issueCounts()).toEqual({
      open: 0,
      acknowledged: 0,
      resolved: 0,
      ignored: 0,
    });
  });

  test('a batch settles each route on its last delivery', async () => {
    const a = await addHook(t);
    const b = await addHook(t);
    await send(t, { id: 'one' });
    const first = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record(
      first.map((c) => outcome(c, { ok: false })),
      POLICY
    );
    expect((await list('open')).map((issue) => issue.webhookId).sort()).toEqual(
      [a.id, b.id].sort()
    );
    await send(t, { id: 'two' });
    const second = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record(
      second.map((c) => outcome(c, { ok: c.webhookId === a.id })),
      POLICY
    );
    expect((await list('open')).map((issue) => issue.webhookId)).toEqual([b.id]);
    expect((await list('resolved')).map((issue) => issue.webhookId)).toEqual([a.id]);
  });

  test('deleting the route deletes its issues', async () => {
    const hook = await addHook(t);
    await run(false);
    await t.store.webhooks.delete(hook.id);
    expect(await t.store.webhooks.issueCounts()).toMatchObject({ open: 0 });
  });

  test('setting a status: any live status to any other, no change for the same, resolved is final', async () => {
    await addHook(t);
    await run(false);
    const [issue] = await list('open');
    const set = (status: 'open' | 'acknowledged' | 'resolved' | 'ignored', by = 'bob') =>
      t.store.webhooks.setIssueStatus(issue!.id, status, by);
    expect(await set('acknowledged')).toMatchObject({ issue: { status: 'acknowledged' } });
    t.clock.advance(5);
    const same = await set('acknowledged', 'carol');
    expect(same).toMatchObject({
      outcome: 'updated',
      issue: { status: 'acknowledged', updatedBy: 'bob' },
    });
    expect(await set('ignored')).toMatchObject({ issue: { status: 'ignored' } });
    expect(await set('open')).toMatchObject({ issue: { status: 'open' } });
    await set('resolved');
    expect(await set('open')).toEqual({ outcome: 'resolved' });
    expect(await set('resolved')).toMatchObject({ outcome: 'updated' });
    expect(await t.store.webhooks.setIssueStatus('987654', 'open', 'bob')).toEqual({
      outcome: 'not_found',
    });
  });

  test('bad input is refused by name', async () => {
    const refuse = async (call: () => Promise<unknown>, option: string) => {
      const error = await call().catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'UnsupportedOptionError', option });
    };
    await refuse(() => t.store.webhooks.issues({ status: 'gone' as never }), 'status');
    await refuse(() => t.store.webhooks.issues({ status: 'open', limit: 0 }), 'limit');
    await refuse(() => t.store.webhooks.issues({ status: 'open', before: 'x' }), 'before');
    await refuse(() => t.store.webhooks.setIssueStatus('x', 'open', 'bob'), 'id');
    await refuse(() => t.store.webhooks.setIssueStatus('1', 'gone' as never, 'bob'), 'status');
  });

  test('the list is newest first, pages, and filters by route', async () => {
    const hooks = [await addHook(t), await addHook(t)];
    await send(t);
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      POLICY
    );
    const all = await t.store.webhooks.issues({ status: 'open', limit: 1 });
    expect(all.items).toHaveLength(1);
    expect(all.next).toBe(all.items[0]!.id);
    const rest = await t.store.webhooks.issues({ status: 'open', before: all.next! });
    expect(rest).toMatchObject({ items: [{ webhookId: expect.any(String) }], next: null });
    expect(rest.items[0]!.webhookId).not.toBe(all.items[0]!.webhookId);
    const only = await t.store.webhooks.issues({ status: 'open', webhook: hooks[1]!.id });
    expect(only.items.map((issue) => issue.webhookId)).toEqual([hooks[1]!.id]);
  });

  test('retention removes resolved issues past the keep time and nothing live', async () => {
    await addHook(t);
    await run(false);
    await run(true);
    await run(false);
    expect(await t.store.webhooks.issueCounts()).toMatchObject({ open: 1, resolved: 1 });
    await t.store.webhooks.prune(100);
    expect(await t.store.webhooks.issueCounts()).toMatchObject({ open: 1, resolved: 1 });
    t.clock.advance(DEFAULT_WEBHOOK_KEEP_MS + 1);
    await t.store.webhooks.prune(100);
    expect(await t.store.webhooks.issueCounts()).toMatchObject({ open: 1, resolved: 0 });
  });
});
