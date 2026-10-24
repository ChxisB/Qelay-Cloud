import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

/** The error a statement ends with, or null when it succeeds (a Bun.SQL query is a thenable, not a Promise). */
const failure = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => null,
    (error: unknown) => error
  );

/** Version 20 as it shipped: later migrations drop what its release-before-it statements name. */
const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);

describeDb('schema migrate: inbound sources (version 20)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 19 keeps its routes and deliveries, applies without drift, and a release before it still writes them', async () => {
    await migrate(fresh.db, { migrations: upTo(19) });
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('ns', 'old', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1)`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'old', 'job.failed', 'q', 'j1', 1, 'pending', 1, 1)`;

    expect((await migrate(fresh.db, { migrations: upTo(20) })).to).toBe(20);
    // A second run checks the recorded checksums of every version, this one's included.
    expect((await migrate(fresh.db, { migrations: upTo(20) })).to).toBe(20);

    // The statements the release before this one runs: they name neither `source_id` nor `request_id`.
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('ns', 'older-release', 'https://b.example.com/', ARRAY['job.failed'], 'me', 2)`;
    await fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, event_name, queue, job_id, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'old', 'job.failed', 'q', 'j2', 2, 'pending', 2, 2)`;
    const routes = await fresh.sql<Array<{ id: string; source_id: string | null }>>`
      SELECT id, source_id FROM qcloud_webhooks ORDER BY id`;
    expect(routes).toEqual([
      { id: 'old', source_id: null },
      { id: 'older-release', source_id: null },
    ]);
    const [{ n }] = await fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_deliveries WHERE request_id IS NULL`;
    expect(n).toBe(2);
  });

  test('the keys hold: a route needs events or a source, a source in use cannot be deleted, a request goes with its source', async () => {
    await migrate(fresh.db, { migrations: upTo(20) });
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('ns', 's1', 'One', 'h1', 'me', 1, 1)`;
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
        VALUES ('ns', 'w0', 'https://a.example.com/', '{}', 'me', 1)`)
    ).not.toBeNull();
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at, source_id)
      VALUES ('ns', 'w1', 'https://a.example.com/', '{}', 'me', 1, 's1')`;
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at, source_id)
        VALUES ('ns', 'w2', 'https://a.example.com/', '{}', 'me', 1, 'missing')`)
    ).not.toBeNull();
    expect(await failure(fresh.sql`DELETE FROM qcloud_sources WHERE id = 's1'`)).not.toBeNull();
    // The same name and token hash in another namespace are fine; in the same one they are not.
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('other', 's1', 'One', 'h1', 'me', 1, 1)`;
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
        VALUES ('ns', 's2', 'One', 'h2', 'me', 1, 1)`)
    ).not.toBeNull();
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
        VALUES ('ns', 's3', 'Three', 'h1', 'me', 1, 1)`)
    ).not.toBeNull();

    await fresh.sql`
      INSERT INTO qcloud_requests (namespace, source_id, received_at, method, status)
      VALUES ('other', 's1', 1, 'POST', 'accepted')`;
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_requests (namespace, source_id, received_at, method, status)
        VALUES ('ns', 'missing', 1, 'POST', 'accepted')`)
    ).not.toBeNull();
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_requests (namespace, source_id, received_at, method, status)
        VALUES ('ns', 's1', 1, 'POST', 'maybe')`)
    ).not.toBeNull();
    await fresh.sql`DELETE FROM qcloud_sources WHERE namespace = 'other'`;
    expect(await fresh.sql`SELECT 1 FROM qcloud_requests`).toHaveLength(0);
  });

  test('a request is delivered to a route once, and a replay is a later created_at', async () => {
    await migrate(fresh.db);
    await fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('ns', 's1', 'One', 'h1', 'me', 1, 1)`;
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at, source_id)
      VALUES ('ns', 'w1', 'https://a.example.com/', 'me', 1, 's1')`;
    const insert = (createdAt: number) => fresh.sql`
      INSERT INTO qcloud_deliveries
        (namespace, webhook_id, request_id, event_name, occurred_at, status, next_attempt_at, created_at)
      VALUES ('ns', 'w1', 7, 'request.received', 1, 'pending', 1, ${createdAt})`;
    await insert(1_000);
    expect(await failure(insert(1_000))).not.toBeNull();
    // A replay has a later created_at, which the partition key makes part of the unique key.
    expect(await failure(insert(2_000))).toBeNull();
    expect(await fresh.sql`SELECT 1 FROM qcloud_deliveries WHERE request_id = 7`).toHaveLength(2);
  });
});
