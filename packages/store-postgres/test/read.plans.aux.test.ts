import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { CLEAN_CANDIDATES } from '../src/store/clean';
import { COMPLETION_CANDIDATES, COMPLETION_CUT } from '../src/store/completions';
import { IDLE_GROUPS } from '../src/store/groupRetention';
import { TRIM_JOB_LOGS } from '../src/store/logs';
import { PRUNE_METRIC_BUCKETS } from '../src/store/metricRetention';
import {
  JOB_LOGS,
  NAMESPACE_TOTALS,
  THROUGHPUT_BUCKETS,
  THROUGHPUT_TOTALS,
} from '../src/store/readQueries';
import { COVER_RINGS } from '../src/store/ringCover';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import type { Planned } from './planHelpers';
import { checkPlanned, explain, visited } from './planHelpers';

const NOW = 5_000_000;
const MINUTES = 20_160;
const KEEP = 50_000;

/**
 * The statements of logs, throughput and retention, planned on tables of production size: 100 lines
 * for each of 1,000 jobs, fourteen days of minute buckets for five queues, a completion table over its
 * keep limit, and a queue of grouped jobs. `read.plans.test.ts` holds the job read models.
 */
const PLANNED: readonly Planned[] = [
  {
    name: 'a job’s log lines',
    statement: { text: JOB_LOGS, params: ['ns', 'j42-q1', 1_000] },
    indexes: ['qcloud_job_logs_job_idx'],
    ordered: true,
  },
  {
    name: 'trimming a job’s log lines',
    statement: { text: TRIM_JOB_LOGS, params: ['ns', 'j42-q1', 100] },
    indexes: ['qcloud_job_logs_job_idx'],
    writes: true,
  },
  {
    name: 'throughput of the last day',
    statement: {
      text: THROUGHPUT_BUCKETS,
      params: ['ns', 'q1', Math.floor(NOW / 60_000) - 1_439, Math.floor(NOW / 60_000)],
    },
    indexes: ['qcloud_metric_buckets_pkey'],
    ordered: true,
  },
  {
    name: 'throughput of the whole fourteen days',
    statement: {
      text: THROUGHPUT_BUCKETS,
      params: ['ns', 'q1', 1, MINUTES],
    },
    indexes: ['qcloud_metric_buckets_pkey'],
    ordered: true,
  },
  {
    // Two rows per queue: for a table this small the planner may fairly read all of it. With
    // sequential scans off the check is that the primary key can serve the read.
    name: 'lifetime totals of a queue',
    statement: { text: THROUGHPUT_TOTALS, params: ['ns', 'q1'] },
    indexes: ['qcloud_metric_totals_pkey'],
    forceIndex: true,
  },
  {
    name: 'lifetime totals of the namespace, every queue',
    statement: { text: NAMESPACE_TOTALS, params: ['ns'] },
    indexes: ['qcloud_metric_totals_pkey'],
    forceIndex: true,
  },
  {
    name: 'clean: the oldest completed jobs of a queue past a grace period',
    statement: { text: CLEAN_CANDIDATES, params: ['ns', 'q1', 'completed', NOW, 1_001] },
    indexes: ['qcloud_jobs_state_idx'],
    ordered: true,
  },
  {
    name: 'clean: failed jobs, a rare state',
    statement: { text: CLEAN_CANDIDATES, params: ['ns', 'q1', 'failed', NOW, 1_001] },
    indexes: ['qcloud_jobs_state_idx'],
    ordered: true,
  },
  {
    name: 'completion prune: the cut at the keep limit',
    statement: { text: COMPLETION_CUT, params: ['ns', KEEP] },
    indexes: ['qcloud_completions_recent_idx'],
    ordered: true,
  },
  {
    name: 'completion prune: the records past the cut that nothing needs',
    statement: { text: COMPLETION_CANDIDATES, params: ['ns', 50_000, 'c50000', 1_001] },
    indexes: ['qcloud_completions_recent_idx'],
    ordered: true,
  },
  {
    name: 'metric prune: buckets past the retention, a probe per queue',
    statement: { text: PRUNE_METRIC_BUCKETS, params: ['ns', 1_000, 1_000] },
    // The totals are two rows per queue, so reading them all is fair; the buckets are the big table.
    indexes: ['qcloud_metric_buckets_pkey'],
    forceIndex: true,
    writes: true,
  },
  {
    name: 'ring cover: the latest recent bell of each queue, a backward range scan',
    statement: {
      text: COVER_RINGS,
      params: ['ns', NOW, 1_000, JSON.stringify([{ id: 'a', queue: 'q' }])],
    },
    indexes: ['qcloud_jobs_ring_idx'],
    writes: true,
  },
  {
    name: 'group prune: idle groups',
    statement: { text: IDLE_GROUPS, params: ['ns', NOW, 1_001] },
    indexes: ['qcloud_group_state_pkey'],
    ordered: true,
  },
];

describeDb('logs, throughput and retention: query plans on seeded tables', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
    await migrate(fresh.db);
    for (const namespace of ['ns', 'other']) {
      // Jobs of five queues, a tenth of them failed and four in ten completed, as in the read-model plans.
      for (let queue = 1; queue <= 5; queue++) {
        await fresh.sql.unsafe(`
          INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at,
                                   lease_until, completed_at)
          SELECT '${namespace}', 'j' || g || '-q${queue}', 'q${queue}', '\\x00'::bytea,
                 (ARRAY['waiting', 'delayed', 'waiting-children', 'active', 'failed',
                        'completed', 'completed', 'completed', 'completed', 'completed'])[1 + g % 10],
                 g, g, CASE WHEN g % 10 = 3 THEN ${NOW} END, CASE WHEN g % 10 >= 4 THEN g END
          FROM generate_series(1, 4000) g`);
      }
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
        SELECT '${namespace}', 'j' || (g % 1000) || '-q1', g, 'info', 'line ' || g
        FROM generate_series(1, 100000) g`);
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_metric_buckets (namespace, queue, metric_type, minute, count)
        SELECT '${namespace}', 'q' || q, type, m, 1 + m % 7
        FROM generate_series(1, 5) q, unnest(ARRAY['completed', 'failed']) type,
             generate_series(1, ${MINUTES}) m`);
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_metric_totals (namespace, queue, metric_type, total_count, prev_ts, prev_count)
        SELECT '${namespace}', 'q' || q, type, 1000000, 0, 0
        FROM generate_series(1, 5) q, unnest(ARRAY['completed', 'failed']) type`);
      // More completions than the keep limit; most have no job row, 1 in 10 still has one.
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_completions (namespace, job_id, queue, completed_at)
        SELECT '${namespace}', 'c' || g, 'q1', g FROM generate_series(1, 100000) g`);
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at, completed_at)
        SELECT '${namespace}', 'c' || g, 'q1', '\\x00'::bytea, 'completed', g, g, g
        FROM generate_series(1, 100000, 10) g`);
      // Groups: 20,000 in one queue, half with a rotation position, a tenth with a limit; three in ten
      // have a live job, in the three states that hold a group.
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_group_state (namespace, queue, group_id, last_served, rate_limit, rate_duration_ms)
        SELECT '${namespace}', 'gq', 'g' || g, CASE WHEN g % 2 = 0 THEN g END,
               CASE WHEN g % 10 = 0 THEN 5 END, CASE WHEN g % 10 = 0 THEN 1000 END
        FROM generate_series(1, 20000) g`);
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at, group_id,
                                 lease_until, completed_at)
        SELECT '${namespace}', 'gj' || g, 'gq', '\\x00'::bytea,
               (ARRAY['waiting', 'active', 'waiting-children', 'completed', 'completed',
                      'completed', 'completed', 'completed', 'completed', 'completed'])[1 + g % 10],
               g, g, 'g' || (g % 20000), CASE WHEN g % 10 = 1 THEN ${NOW} END,
               CASE WHEN g % 10 >= 3 THEN g END
        FROM generate_series(1, 40000) g`);
    }
    for (const table of [
      'jobs',
      'job_logs',
      'metric_buckets',
      'metric_totals',
      'completions',
      'group_state',
    ]) {
      await fresh.sql.unsafe(`VACUUM ANALYZE qcloud_${table}`);
    }
  }, 300_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  test('the seeded tables are the size the plans are meant for', async () => {
    const [row] = await fresh.sql<Array<{ logs: string; buckets: string; completions: string }>>`
      SELECT (SELECT count(*) FROM qcloud_job_logs) AS logs,
             (SELECT count(*) FROM qcloud_metric_buckets) AS buckets,
             (SELECT count(*) FROM qcloud_completions) AS completions`;
    expect(Number(row!.logs)).toBe(200_000);
    expect(Number(row!.buckets)).toBe(2 * 5 * 2 * MINUTES);
    expect(Number(row!.completions)).toBe(200_000);
  });

  test.each(PLANNED.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    await checkPlanned(fresh, entry);
  });

  test('a job’s lines are read by the job’s own index entries, not the namespace’s', async () => {
    const nodes = await explain(fresh, {
      text: JOB_LOGS,
      params: ['ns', 'j42-q1', 1_000],
    });
    expect(visited(nodes, 'qcloud_job_logs')).toBeLessThanOrEqual(100);
  });

  test('a day of throughput reads a day of buckets', async () => {
    const nodes = await explain(fresh, {
      text: THROUGHPUT_BUCKETS,
      params: ['ns', 'q1', 1, 1_440],
    });
    expect(visited(nodes, 'qcloud_metric_buckets')).toBeLessThanOrEqual(2 * 1_440);
  });

  test('a clean pass reads the entries it deletes, plus those it must skip', async () => {
    const nodes = await explain(fresh, {
      text: CLEAN_CANDIDATES,
      params: ['ns', 'q1', 'completed', NOW, 1_001],
    });
    expect(visited(nodes, 'qcloud_jobs')).toBeLessThan(2_500);
  });

  test('the completion cut reads the keep limit of index entries and no table rows', async () => {
    const nodes = await explain(fresh, { text: COMPLETION_CUT, params: ['ns', KEEP] });
    expect(nodes.map((node) => node['Node Type'])).toContain('Index Only Scan');
    expect(visited(nodes, 'qcloud_completions')).toBeLessThanOrEqual(KEEP + 1);
  });

  test('the completion candidates stop at the limit however many records are past the cut', async () => {
    const nodes = await explain(fresh, {
      text: COMPLETION_CANDIDATES,
      params: ['ns', 50_000, 'c50000', 1_001],
    });
    // Records with a job row are skipped: one in ten of the oldest, so about 1,112 entries for 1,001.
    expect(visited(nodes, 'qcloud_completions')).toBeLessThan(2_500);
  });

  test('a group pass reads the groups it examines and no more', async () => {
    const nodes = await explain(fresh, { text: IDLE_GROUPS, params: ['ns', NOW, 1_001] });
    expect(visited(nodes, 'qcloud_group_state')).toBeLessThan(5_000);
  });
});
