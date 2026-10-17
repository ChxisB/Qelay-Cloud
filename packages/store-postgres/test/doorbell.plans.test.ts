import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { OLDEST_READY, READY_PROBE } from '../src/store/doorbell';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import { checkPlanned, explain, visited } from './planHelpers';

const NOW = 5_000_000;

/**
 * The local transport's poll probe and its oldest-age read, planned on a table of production size:
 * `backlog` holds 50,000 claimable jobs, `later` 50,000 delayed jobs none of which is due, `done`
 * 50,000 completed ones, and `mixed` a thousand of each kind in one queue.
 */
describeDb('doorbell: query plans on seeded tables', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
    await migrate(fresh.db);
    const seed = (queue: string, state: string, rows: number, runAt: string) =>
      fresh.sql.unsafe(`
        INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at, completed_at)
        SELECT 'ns', '${queue}-${state}-' || g, '${queue}', '\\x00'::bytea, '${state}', ${runAt}, g,
               CASE WHEN '${state}' = 'completed' THEN g END
        FROM generate_series(1, ${rows}) g`);
    await seed('backlog', 'waiting', 50_000, 'g');
    await seed('later', 'delayed', 50_000, `${NOW} + g`);
    await seed('done', 'completed', 50_000, 'g');
    await seed('mixed', 'waiting', 1_000, 'g');
    await seed('mixed', 'delayed', 1_000, `${NOW} + g`);
    await seed('mixed', 'completed', 1_000, 'g');
    await fresh.sql.unsafe('VACUUM ANALYZE qcloud_jobs');
  }, 120_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  const probe = (queue: string) => ({ text: READY_PROBE, params: ['ns', queue, NOW] });

  test.each(['backlog', 'later', 'done', 'mixed'])(
    'the poll probe on the %s queue reads the ready index',
    async (queue) => {
      await checkPlanned(fresh, {
        name: `probe ${queue}`,
        statement: probe(queue),
        indexes: ['qcloud_jobs_ready_idx'],
      });
    }
  );

  test('a queue with a claimable job is answered by the first entries, however long its backlog', async () => {
    const nodes = await explain(fresh, probe('backlog'));
    expect(visited(nodes, 'qcloud_jobs')).toBeLessThanOrEqual(10);
  });

  test('a queue of completed jobs is answered without touching them', async () => {
    const nodes = await explain(fresh, probe('done'));
    expect(visited(nodes, 'qcloud_jobs')).toBeLessThanOrEqual(10);
  });

  test('a queue whose jobs are all delayed past now reads no table row', async () => {
    const nodes = await explain(fresh, probe('later'));
    // The `run_at` test is applied to the index entry, so no heap row is fetched. The queue's 50,000
    // entries are still walked (the claim's own select does the same), which is the probe's worst
    // case and is bounded by the poll interval; the cloud transports do not poll the database.
    expect(visited(nodes, 'qcloud_jobs')).toBeLessThanOrEqual(10);
  });

  test('the oldest claimable age reads the ready index only', async () => {
    await checkPlanned(fresh, {
      name: 'oldest claimable',
      statement: { text: OLDEST_READY, params: ['ns', 'mixed', NOW] },
      indexes: ['qcloud_jobs_ready_idx'],
    });
  });
});
