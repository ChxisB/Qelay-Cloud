import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { LATEST_VERSION, MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

/** The error a statement ends with, or null when it succeeds (a Bun.SQL query is a thenable, not a Promise). */
const failure = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => null,
    (error: unknown) => error
  );

describeDb('schema migrate: saved destinations (version 19)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 18 keeps its webhooks, none made from a destination, and a release that predates it still writes them', async () => {
    await migrate(fresh.db, { migrations: MIGRATIONS.filter((m) => m.version <= 18) });
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('ns', 'old', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1)`;

    expect((await migrate(fresh.db)).to).toBe(LATEST_VERSION);
    // The statement the release before this one runs: it names no `destination_id`.
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('ns', 'older-release', 'https://b.example.com/', ARRAY['job.failed'], 'me', 2)`;
    const rows = await fresh.sql<Array<{ id: string; destination_id: string | null }>>`
      SELECT id, destination_id FROM qcloud_webhooks ORDER BY id`;
    expect(rows).toEqual([
      { id: 'old', destination_id: null },
      { id: 'older-release', destination_id: null },
    ]);
  });

  test('the key restricts: a destination in use cannot be deleted, a missing one cannot be named', async () => {
    await migrate(fresh.db);
    await fresh.sql`
      INSERT INTO qcloud_webhook_destinations
        (namespace, id, name, kind, url, created_by, created_at, updated_at)
      VALUES ('ns', 'd1', 'Billing', 'http', 'https://a.example.com/', 'me', 1, 1)`;
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at, destination_id)
      VALUES ('ns', 'w1', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1, 'd1')`;
    expect(
      await failure(fresh.sql`DELETE FROM qcloud_webhook_destinations WHERE id = 'd1'`)
    ).not.toBeNull();
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at, destination_id)
        VALUES ('ns', 'w2', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1, 'missing')`)
    ).not.toBeNull();
    // The same name in another namespace is fine; in the same one it is not.
    await fresh.sql`
      INSERT INTO qcloud_webhook_destinations
        (namespace, id, name, kind, target, created_by, created_at, updated_at)
      VALUES ('other', 'd1', 'Billing', 'queue', 'q', 'me', 1, 1)`;
    expect(
      await failure(fresh.sql`
        INSERT INTO qcloud_webhook_destinations
          (namespace, id, name, kind, url, created_by, created_at, updated_at)
        VALUES ('ns', 'd2', 'Billing', 'http', 'https://b.example.com/', 'me', 1, 1)`)
    ).not.toBeNull();
  });
});
