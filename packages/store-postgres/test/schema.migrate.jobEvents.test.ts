import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

const REASON = "its source, a queue's job events, was removed";
const AT_20 = MIGRATIONS.filter((m) => m.version <= 20);

describeDb('schema migrate: the job events are removed (version 21)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a version 20 database keeps its routes and deliveries, disables the routes with no source and fails their unfinished deliveries', async () => {
    await migrate(fresh.db, { migrations: AT_20 });
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('ns', 's1', 'One', 'h1', 'me', 1, 1)`;
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at, source_id)
      VALUES ('ns', 'legacy', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1, NULL),
             ('ns', 'sourced', 'https://b.example.com/', '{}', 'me', 1, 's1')`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'legacy', 5, 'job.failed', 'q', 'j1', 1, 'pending', 1, 1),
             ('ns', 'legacy', 6, 'job.failed', 'q', 'j2', 1, 'delivered', 1, 1)`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, request_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'sourced', 9, 'request.received', 's1', '9', 1, 'pending', 1, 1)`;

    expect((await migrate(fresh.db)).to).toBe(MIGRATIONS.at(-1)!.version);
    // A second run checks the recorded checksum of every version, this one's included.
    expect((await migrate(fresh.db)).to).toBe(MIGRATIONS.at(-1)!.version);

    const routes = await fresh.sql<
      Array<{ id: string; enabled: boolean; disabled_reason: string | null }>
    >`SELECT id, enabled, disabled_reason FROM qcloud_webhooks ORDER BY id`;
    expect(routes).toEqual([
      { id: 'legacy', enabled: false, disabled_reason: REASON },
      { id: 'sourced', enabled: true, disabled_reason: null },
    ]);
    const deliveries = await fresh.sql<
      Array<{ webhook_id: string; status: string; last_error: string | null }>
    >`
      SELECT webhook_id, status, last_error FROM qcloud_deliveries ORDER BY webhook_id, id`;
    expect(deliveries).toEqual([
      { webhook_id: 'legacy', status: 'failed', last_error: REASON },
      { webhook_id: 'legacy', status: 'delivered', last_error: null },
      { webhook_id: 'sourced', status: 'pending', last_error: null },
    ]);
  });

  test('the trigger, its function, the writer table and the route columns are gone, and a delivery needs no job', async () => {
    await migrate(fresh.db);
    const [gone] = await fresh.sql<
      Array<{ triggers: number; functions: number; tables: number; columns: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${fresh.name} AND t.tgname = 'qcloud_events_webhook_deliveries') AS triggers,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ${fresh.name} AND p.proname = 'qcloud_enqueue_webhook_deliveries') AS functions,
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = ${fresh.name} AND table_name = 'qcloud_webhook_writers') AS tables,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = ${fresh.name} AND table_name = 'qcloud_webhooks'
            AND column_name IN ('events', 'queue', 'active_from')) AS columns`;
    expect(gone).toEqual({ triggers: 0, functions: 0, tables: 0, columns: 0 });
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('ns', 's1', 'One', 'h1', 'me', 1, 1)`;
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at, source_id)
      VALUES ('ns', 'w1', 'https://a.example.com/', 'me', 1, 's1')`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, request_id, event_name, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'w1', 1, 'request.received', 1, 'pending', 1, 1)`;
    const [row] = await fresh.sql<Array<{ queue: string | null; job_id: string | null }>>`
      SELECT queue, job_id FROM qcloud_deliveries`;
    expect(row).toEqual({ queue: null, job_id: null });
  });
});
