import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, rawDeliveries } from './webhookHelpers';

const SECOND = 1_000;

describeDb('webhooks: the writer applies delay and dedupe (migration 17)', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.store.webhooks.startWriter();
  });

  const write = () => t.store.webhooks.writeDeliveries();
  const jobs = async () => (await rawDeliveries(t)).map((r) => r.job_id);
  const failed = (jobId: string, error: string) =>
    event('failed', 'q', jobId, { error, state: 'failed' });
  const windows = () =>
    t.fresh.sql<Array<{ webhook_id: string; until: string }>>`
      SELECT webhook_id, until FROM qcloud_webhook_dedupe ORDER BY webhook_id, key`;

  test('a delay makes the delivery now but not claimable until it is due', async () => {
    await addHook(t, { delayMs: 5 * SECOND });
    const at = t.clock.now();
    await journal(t, [event('pushed', 'q', 'j1')]);
    await write();
    const [row] = await rawDeliveries(t);
    expect(Number(row!.next_attempt_at)).toBe(at + 5 * SECOND);
    expect(await t.store.webhooks.claimDue(CLAIM)).toEqual([]);
    t.clock.advance(5 * SECOND - 1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toEqual([]);
    t.clock.advance(1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
  });

  test('a webhook without a delay is due at the time of its event', async () => {
    await addHook(t);
    const at = t.clock.now();
    await journal(t, [event('pushed', 'q', 'j1')]);
    await write();
    expect(Number((await rawDeliveries(t))[0]!.next_attempt_at)).toBe(at);
  });

  test('dedupe: the first event of a kind goes, the repeats inside the window do not', async () => {
    await addHook(t, { dedupe: { windowMs: 10 * SECOND, fields: ['event', 'queue', 'error'] } });
    await journal(t, [failed('a', 'boom'), failed('b', 'boom'), failed('c', 'other')]);
    await write();
    expect(await jobs()).toEqual(['a', 'c']);
    // The next page is still inside the window.
    t.clock.advance(3 * SECOND);
    await journal(t, [failed('d', 'boom'), failed('e', 'other')]);
    await write();
    expect(await jobs()).toEqual(['a', 'c']);
  });

  test('dedupe: after the window the next one goes, and starts a new window', async () => {
    await addHook(t, { dedupe: { windowMs: 10 * SECOND, fields: ['event', 'error'] } });
    await journal(t, [failed('a', 'boom')]);
    await write();
    t.clock.advance(10 * SECOND);
    await journal(t, [failed('b', 'boom')]);
    await write();
    t.clock.advance(SECOND);
    await journal(t, [failed('c', 'boom')]);
    await write();
    expect(await jobs()).toEqual(['a', 'b']);
  });

  test('dedupe: events of one page that are further apart than the window both go', async () => {
    await addHook(t, { dedupe: { windowMs: 2 * SECOND, fields: ['event', 'error'] } });
    await journal(t, [failed('a', 'boom')]);
    t.clock.advance(SECOND);
    await journal(t, [failed('b', 'boom')]);
    t.clock.advance(2 * SECOND);
    await journal(t, [failed('c', 'boom')]);
    await write();
    expect(await jobs()).toEqual(['a', 'c']);
  });

  test('dedupe is per webhook, and a filtered-out event does not start a window', async () => {
    const strict = await addHook(t, {
      filter: { queue: 'only' },
      dedupe: { windowMs: 60 * SECOND, fields: ['event'] },
    });
    const loose = await addHook(t, { dedupe: { windowMs: 60 * SECOND, fields: ['event'] } });
    await journal(t, [
      failed('a', 'x'),
      event('failed', 'only', 'b', { error: 'x', state: 'failed' }),
    ]);
    await write();
    const made = (await rawDeliveries(t)).map(
      (r) => `${r.webhook_id === strict.id ? 's' : 'l'}:${r.job_id}`
    );
    expect(made.sort()).toEqual(['l:a', 's:b']);
    expect(loose.id).not.toBe(strict.id);
  });

  test('a delivery made twice (a repeated pass) does not lengthen or break a window', async () => {
    await addHook(t, { dedupe: { windowMs: 10 * SECOND, fields: ['event'] } });
    await journal(t, [failed('a', 'x')]);
    await t.fresh.sql`UPDATE qcloud_webhook_writers SET commit_seq = 0, event_id = 0`;
    await write();
    const before = await windows();
    await t.fresh.sql`UPDATE qcloud_webhook_writers SET commit_seq = 0, event_id = 0`;
    await write();
    expect(await jobs()).toEqual(['a']);
    expect(await windows()).toEqual(before);
  });

  test('a pass that fails writes no window', async () => {
    await addHook(t, { dedupe: { windowMs: 10 * SECOND, fields: ['event'] } });
    await journal(t, [failed('a', 'x')]);
    // A cursor row that cannot move makes the pass fail after the deliveries and the window were written.
    await t.fresh.sql`
      CREATE FUNCTION qcloud_test_refuse() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`;
    await t.fresh.sql`
      CREATE TRIGGER qcloud_test_refuse BEFORE UPDATE ON qcloud_webhook_writers
      FOR EACH ROW EXECUTE FUNCTION qcloud_test_refuse()`;
    try {
      await expect(write()).rejects.toThrow();
    } finally {
      await t.fresh.sql`DROP TRIGGER qcloud_test_refuse ON qcloud_webhook_writers`;
      await t.fresh.sql`DROP FUNCTION qcloud_test_refuse()`;
    }
    expect(await rawDeliveries(t)).toEqual([]);
    expect(await windows()).toEqual([]);
    await write();
    expect(await jobs()).toEqual(['a']);
  });

  test('retention removes only the windows that have ended', async () => {
    await addHook(t, { dedupe: { windowMs: 10 * SECOND, fields: ['error'] } });
    await journal(t, [failed('a', 'old')]);
    t.clock.advance(20 * SECOND);
    await journal(t, [failed('b', 'new')]);
    await write();
    expect(await windows()).toHaveLength(2);
    await t.store.webhooks.prune(100);
    const left = await windows();
    expect(left).toHaveLength(1);
    expect(Number(left[0]!.until)).toBeGreaterThan(t.clock.now());
  });
});
