import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { LATEST_VERSION, MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

describeDb('schema migrate: issues (version 18)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 17 gets one open issue for each route failing or paused for failing', async () => {
    const before = MIGRATIONS.filter((migration) => migration.version <= 17);
    await migrate(fresh.db, { migrations: before });
    // Healthy, failing (a streak), paused for failing (the streak was reset by nothing), and a route disabled by hand.
    await fresh.sql`
      INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
      VALUES ('ns', 'healthy', 'https://a.example.com/', ARRAY['job.failed'], 'me', 1),
             ('ns', 'failing', 'https://b.example.com/', ARRAY['job.failed'], 'me', 1),
             ('ns', 'paused', 'https://c.example.com/', ARRAY['job.failed'], 'me', 1),
             ('ns', 'off', 'https://d.example.com/', ARRAY['job.failed'], 'me', 1)`;
    await fresh.sql`UPDATE qcloud_webhooks SET consecutive_failures = 2 WHERE id = 'failing'`;
    await fresh.sql`
      UPDATE qcloud_webhooks SET enabled = FALSE, disabled_reason = '5 failed deliveries in a row',
             disabled_at = 1234, consecutive_failures = 5 WHERE id = 'paused'`;
    await fresh.sql`UPDATE qcloud_webhooks SET enabled = FALSE WHERE id = 'off'`;

    expect((await migrate(fresh.db)).to).toBe(LATEST_VERSION);
    const issues = await fresh.sql<
      Array<{ webhook_id: string; status: string; kind: string; opened_at: string }>
    >`SELECT webhook_id, status, kind, opened_at FROM qcloud_webhook_issues ORDER BY webhook_id`;
    expect(issues.map((issue) => [issue.webhook_id, issue.status, issue.kind])).toEqual([
      ['failing', 'open', 'delivery_failed'],
      ['paused', 'open', 'delivery_failed'],
    ]);
    // The pause time is when it began; a streak with no recorded time begins now.
    expect(Number(issues[1]!.opened_at)).toBe(1234);
    expect(Number(issues[0]!.opened_at)).toBeGreaterThan(1_700_000_000_000);
  });
});
