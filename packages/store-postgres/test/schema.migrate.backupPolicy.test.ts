import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);

describeDb('schema migrate: backup policy (version 25)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 24 keeps its jobs, applies without drift, and the release before still writes them', async () => {
    await migrate(fresh.db, { migrations: upTo(24) });
    await fresh.sql`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at)
      VALUES ('ns', 'before', 'q', '\\x00', 'waiting', 1, 1)`;

    expect((await migrate(fresh.db)).to).toBe(25);
    // A second run checks the recorded checksum of every version, this one's included.
    expect((await migrate(fresh.db)).to).toBe(25);

    // What the release before this one runs: it names no new table, so nothing it does changes.
    await fresh.sql`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at)
      VALUES ('ns', 'older-release', 'q', '\\x00', 'waiting', 1, 2)`;
    const jobs = await fresh.sql<
      Array<{ id: string }>
    >`SELECT id FROM qcloud_jobs ORDER BY created_at`;
    expect(jobs.map((j) => j.id)).toEqual(['before', 'older-release']);

    const [policy] = await fresh.sql<Array<{ n: number | string }>>`
      SELECT count(*) AS n FROM qcloud_backup_policy`;
    expect(Number(policy!.n)).toBe(0);
  });
});
