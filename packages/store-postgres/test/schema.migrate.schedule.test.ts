import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

/**
 * The SQLSTATE a statement ends with, or null when it succeeds (a Bun.SQL query is a thenable, not a Promise). The checks
 * below expect 23514, so a statement that fails for another reason (a misspelt column) cannot pass for the wrong one.
 */
const failure = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => null,
    (error: unknown) => (error as { errno?: string }).errno ?? 'unknown'
  );

const CHECK_VIOLATION = '23514';

const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);

describeDb('schema migrate: route schedule and batch (version 22)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  const source = async () => {
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('ns', 's1', 'One', 'h1', 'me', 1, 1)`;
  };

  test('a database at version 21 keeps its routes and deliveries, applies without drift, and the release before still writes them', async () => {
    await migrate(fresh.db, { migrations: upTo(21) });
    await source();
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at, source_id)
      VALUES ('ns', 'old', 'https://a.example.com/', 'me', 1, 's1')`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, request_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'old', 7, 'request.received', 's1', '7', 1, 'pending', 1, 1)`;

    expect((await migrate(fresh.db, { migrations: upTo(22) })).to).toBe(22);
    // A second run checks the recorded checksum of every version, this one's included.
    expect((await migrate(fresh.db, { migrations: upTo(22) })).to).toBe(22);

    // The statements the release before this one runs: they name none of the new columns.
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at, source_id)
      VALUES ('ns', 'older-release', 'https://b.example.com/', 'me', 2, 's1')`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, request_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'old', 8, 'request.received', 's1', '8', 2, 'pending', 2, 2)`;

    const routes = await fresh.sql<
      Array<{ id: string; schedule_cron: string | null; batch_max_events: number | null }>
    >`SELECT id, schedule_cron, batch_max_events FROM qcloud_webhooks ORDER BY id`;
    expect(routes).toEqual([
      { id: 'old', schedule_cron: null, batch_max_events: null },
      { id: 'older-release', schedule_cron: null, batch_max_events: null },
    ]);
    const [{ n }] = await fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_deliveries WHERE batch_id IS NULL`;
    expect(n).toBe(2);
  });

  test('a schedule and a batch are stored, and the checks hold', async () => {
    await migrate(fresh.db);
    await source();
    await fresh.sql`
      INSERT INTO qcloud_webhooks
        (namespace, id, url, created_by, created_at, source_id,
         schedule_cron, schedule_timezone, batch_max_events, batch_max_bytes)
      VALUES ('ns', 'nightly', 'https://a.example.com/', 'me', 1, 's1', '0 0 * * *', 'Europe/London', 100, 262144)`;
    const row = (id: string, extra: string, value: unknown) =>
      failure(
        fresh.sql.unsafe(
          `INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at, source_id, ${extra})
         VALUES ('ns', '${id}', 'https://a.example.com/', 'me', 1, 's1', ${value})`
        )
      );
    // A cron with no zone, a zone with no cron.
    expect(await row('c1', 'schedule_cron', `'0 0 * * *'`)).toBe(CHECK_VIOLATION);
    expect(await row('c2', 'schedule_timezone', `'UTC'`)).toBe(CHECK_VIOLATION);
    // A batch with one of its two limits, or with a limit outside the bounds.
    expect(await row('b1', 'batch_max_events', '10')).toBe(CHECK_VIOLATION);
    expect(await row('b2', 'batch_max_bytes', '4096')).toBe(CHECK_VIOLATION);
    for (const [id, events, bytes] of [
      ['b3', 0, 4096],
      ['b4', 501, 4096],
      ['b5', 10, 1023],
      ['b6', 10, 1048577],
    ] as const) {
      expect(await row(id, 'batch_max_events, batch_max_bytes', `${events}, ${bytes}`)).toBe(
        CHECK_VIOLATION
      );
    }
    expect(await row('ok', 'batch_max_events, batch_max_bytes', '500, 1048576')).toBeNull();
  });

  test('a queue route cannot carry a batch', async () => {
    await migrate(fresh.db);
    await source();
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhooks
          (namespace, id, url, created_by, created_at, source_id, destination, target,
           batch_max_events, batch_max_bytes)
        VALUES ('ns', 'q1', '', 'me', 1, 's1', 'queue', 'jobs', 10, 4096)`)
    ).toBe(CHECK_VIOLATION);
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhooks
          (namespace, id, url, created_by, created_at, source_id, destination, target,
           schedule_cron, schedule_timezone)
        VALUES ('ns', 'q2', '', 'me', 1, 's1', 'queue', 'jobs', '@daily', 'UTC')`)
    ).toBeNull();
  });

  test('every partition of the deliveries has batch_id, the ones made later too', async () => {
    await migrate(fresh.db);
    const later = Date.now() + 40 * 86_400_000;
    await fresh.sql`SELECT qcloud_ensure_delivery_partitions(${later}::bigint, 0)`;
    const columns = await fresh.sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name LIKE 'qcloud_deliveries%' AND column_name = 'batch_id'
      ORDER BY table_name`;
    const partitions = await fresh.sql<Array<{ relname: string }>>`
      SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'qcloud_deliveries'::regclass`;
    expect(partitions.length).toBeGreaterThan(2);
    expect(columns.map((c) => c.table_name).sort()).toEqual(
      ['qcloud_deliveries', ...partitions.map((p) => p.relname)].sort()
    );
  });
});
