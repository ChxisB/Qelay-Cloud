import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import { resetTables } from './finishHelpers';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome, POLICY } from './webhookHelpers';

const DAY = 86_400_000;
const START = 1_800_000_000_000;
const dayEnd = (ms: number) => (Math.floor(ms / DAY) + 1) * DAY;
const nameOf = (ms: number) =>
  `qcloud_deliveries_${new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')}`;

describeDb('webhook deliveries: day partitions', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, webhookKeepMs: DAY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    // Day partitions are not data: remove the ones an earlier test made, so each starts from the migration's.
    await t.fresh.sql`SELECT qcloud_drop_delivery_partitions(${START + 365 * DAY})`;
  });

  const names = async () =>
    (
      await t.fresh.sql<Array<{ name: string }>>`
        SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'qcloud_deliveries'::regclass ORDER BY 1`
    ).map((row) => row.name);
  const ensure = async (now: number) =>
    (
      await t.fresh.sql<
        Array<{ made: number }>
      >`SELECT qcloud_ensure_delivery_partitions(${now}, 3) AS made`
    )[0]!.made;
  const drop = async (before: number) =>
    (
      await t.fresh.sql<
        Array<{ n: number }>
      >`SELECT qcloud_drop_delivery_partitions(${before}) AS n`
    )[0]!.n;
  const homes = async () =>
    (
      await t.fresh.sql<Array<{ part: string }>>`
        SELECT tableoid::regclass::text AS part FROM qcloud_deliveries ORDER BY id`
    ).map((row) => row.part);
  /** One delivery of a webhook, finished or still pending. */
  async function delivery(finished: boolean): Promise<void> {
    await addHook(t);
    await journal(t, [event('pushed')]);
    if (!finished) return;
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record([outcome(claimed[0]!, { ok: true })], POLICY);
  }

  test('makes today and three days ahead, once', async () => {
    expect(await ensure(START)).toBe(4);
    expect(await ensure(START)).toBe(0);
    const have = await names();
    for (let n = 0; n < 4; n++) expect(have).toContain(nameOf(START + n * DAY));
    expect(have).toContain('qcloud_deliveries_default');
  });

  test('a day whose rows already sit in the default partition stays there', async () => {
    await delivery(false);
    expect(await homes()).toEqual(['qcloud_deliveries_default']);
    expect(await ensure(START)).toBe(3);
    expect(await names()).not.toContain(nameOf(START));
    expect(await homes()).toEqual(['qcloud_deliveries_default']);
  });

  test('a delivery goes to its day, and the day is dropped whole once its end is past', async () => {
    await ensure(START);
    await delivery(true);
    expect(await homes()).toEqual([nameOf(START)]);
    expect(await drop(dayEnd(START) - 1)).toBe(0);
    expect(await homes()).toEqual([nameOf(START)]);
    expect(await drop(dayEnd(START))).toBe(1);
    expect(await homes()).toEqual([]);
    expect(await names()).not.toContain(nameOf(START));
  });

  test('a delivery still to be sent keeps its day, and a finished one frees it', async () => {
    await ensure(START);
    await delivery(false);
    // The three empty days after it go; the day of the delivery stays.
    expect(await drop(START + 30 * DAY)).toBe(3);
    expect(await names()).toContain(nameOf(START));
    await t.fresh.sql`UPDATE qcloud_deliveries SET status = 'failed', finished_at = ${START}`;
    expect(await drop(START + 30 * DAY)).toBe(1);
  });

  test('the tick makes the days ahead and drops a day webhookKeepMs after its end', async () => {
    await ensure(START);
    await delivery(true);
    t.clock.advance(DAY);
    await t.store.webhooks.prune(100);
    expect(await names()).toContain(nameOf(START + 4 * DAY));
    expect(await names()).toContain(nameOf(START));
    t.clock.advance(DAY);
    await t.store.webhooks.prune(100);
    expect(await names()).not.toContain(nameOf(START));
    expect(await homes()).toEqual([]);
  });

  test('an event is delivered to a webhook once', async () => {
    await ensure(START);
    await delivery(false);
    await expect(
      (async () => t.fresh.sql`
        INSERT INTO qcloud_deliveries (namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at,
                                       status, next_attempt_at, created_at)
        SELECT namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at
        FROM qcloud_deliveries`)()
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describeDb('webhook deliveries: version 13', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
  });
  afterAll(async () => {
    await fresh.drop();
  });

  test('what is still to be sent moves over with its id, what is finished stays, and ids go on', async () => {
    await migrate(fresh.db, { migrations: MIGRATIONS.filter((m) => m.version < 13) });
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('test', 'w1', 'https://hooks.example.com/in', ARRAY['job.completed'], 'tester', ${START})`;
    await fresh.sql`
      INSERT INTO qcloud_webhook_deliveries (id, namespace, webhook_id, event_name, queue, job_id, occurred_at,
                                             status, next_attempt_at, created_at, finished_at)
      VALUES (7, 'test', 'w1', 'job.completed', 'q', 'a', ${START}, 'pending', ${START}, ${START}, NULL),
             (8, 'test', 'w1', 'job.completed', 'q', 'b', ${START}, 'sending', ${START}, ${START}, NULL),
             (9, 'test', 'w1', 'job.completed', 'q', 'c', ${START}, 'delivered', ${START}, ${START}, ${START})`;
    await migrate(fresh.db);
    const moved = await fresh.sql<Array<{ id: string; status: string }>>`
      SELECT id::text, status FROM qcloud_deliveries ORDER BY id`;
    expect(moved).toEqual([
      { id: '7', status: 'pending' },
      { id: '8', status: 'sending' },
    ]);
    const left = await fresh.sql<
      Array<{ id: string }>
    >`SELECT id::text FROM qcloud_webhook_deliveries`;
    expect(left).toEqual([{ id: '9' }]);
    await fresh.sql`
      INSERT INTO qcloud_deliveries (namespace, webhook_id, event_name, queue, job_id, occurred_at, status,
                                     next_attempt_at, created_at)
      VALUES ('test', 'w1', 'job.completed', 'q', 'd', ${START}, 'pending', ${START}, ${START})`;
    const [next] = await fresh.sql<
      Array<{ id: string }>
    >`SELECT max(id)::text AS id FROM qcloud_deliveries`;
    expect(Number(next!.id)).toBeGreaterThan(9);
  });
});
