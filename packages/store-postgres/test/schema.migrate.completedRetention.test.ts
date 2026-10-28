import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);

describeDb('schema migrate: completed job retention (version 24)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 23 keeps its jobs, applies without drift, and the release before still writes them', async () => {
    await migrate(fresh.db, { migrations: upTo(23) });
    await fresh.sql`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at, completed_at)
      VALUES ('ns', 'old', 'q', '\\x00', 'completed', 1, 1, 5)`;

    expect((await migrate(fresh.db, { migrations: upTo(24) })).to).toBe(24);
    // A second run checks the recorded checksum of every version, this one's included.
    expect((await migrate(fresh.db, { migrations: upTo(24) })).to).toBe(24);

    // What the release before this one runs: it names no new column, and finishing a job only has one more index to keep.
    await fresh.sql`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at)
      VALUES ('ns', 'older-release', 'q', '\\x00', 'active', 1, 2)`;
    await fresh.sql`
      UPDATE qcloud_jobs SET state = 'completed', completed_at = 9
      WHERE namespace = 'ns' AND id = 'older-release'`;

    const [row] = await fresh.sql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'qcloud_jobs_completed_idx'`;
    expect(row?.indexdef).toContain("WHERE (state = 'completed'::text)");
    const rows = await fresh.sql<Array<{ id: string; completed_at: string }>>`
      SELECT id, completed_at FROM qcloud_jobs WHERE state = 'completed' ORDER BY completed_at`;
    expect(rows.map((r) => [r.id, Number(r.completed_at)])).toEqual([
      ['old', 5],
      ['older-release', 9],
    ]);
  });
});
