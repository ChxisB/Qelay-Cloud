import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { JobState } from '@qelay-cloud/core';
import { JOB_STATES } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import type { Statement } from '../src/store/readQueries';
import {
  COUNTS_BY_STATE,
  countInState,
  DASHBOARD_COUNTS,
  JOB_BY_ID,
  jobsInState,
  LIST_JOBS,
  PRIORITY_COUNTS,
  QUEUE_SUMMARIES,
  QUEUE_TOTALS,
} from '../src/store/readQueries';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import type { Planned } from './planHelpers';
import { checkPlanned, explain, visited } from './planHelpers';

const NOW = 5_000_000;

const LIST_PLANS = ['qcloud_jobs_pkey', 'qcloud_jobs_state_idx'];

const listing = (state: JobState, offset = 0): Statement =>
  jobsInState(state, 'ns', 'q1', NOW, 50, offset);

/**
 * Every statement of `readQueries.ts` with sample parameters, and the indexes it must read. The
 * plans come from the default planner on a table of about 200,000 jobs in two namespaces and five
 * queues each, so a sequential scan is a choice the planner made and not a fact of a tiny table.
 */
const PLANNED: readonly Planned[] = [
  {
    name: 'counts by state of one queue',
    statement: { text: COUNTS_BY_STATE, params: ['ns', 'q1', NOW] },
    indexes: ['qcloud_jobs_ready_idx', 'qcloud_jobs_state_idx'],
  },
  {
    name: 'claimable jobs of one queue by priority',
    statement: { text: PRIORITY_COUNTS, params: ['ns', 'q1', NOW] },
    indexes: ['qcloud_jobs_ready_idx'],
  },
  {
    name: 'counts by state of the namespace (dashboard)',
    statement: { text: DASHBOARD_COUNTS, params: ['ns', NOW] },
    indexes: ['qcloud_jobs_ready_idx', 'qcloud_jobs_state_idx'],
  },
  {
    name: 'queue and paused queue totals (dashboard)',
    statement: { text: QUEUE_TOTALS, params: ['ns'] },
    indexes: ['qcloud_queue_state_pkey'],
    forceIndex: true,
  },
  {
    name: 'a page of queue summaries with their counts',
    statement: { text: QUEUE_SUMMARIES, params: ['ns', '', 3, NOW] },
    indexes: ['qcloud_queue_state_pkey', 'qcloud_jobs_ready_idx', 'qcloud_jobs_state_idx'],
  },
  {
    name: 'listJobs, every state, first page',
    statement: { text: LIST_JOBS, params: ['ns', 'q1', '', null, NOW, 51] },
    indexes: [],
    oneOf: LIST_PLANS,
  },
  {
    name: 'listJobs, a small queue, first page',
    statement: { text: LIST_JOBS, params: ['ns', 'tiny', '', null, NOW, 51] },
    indexes: [],
    oneOf: LIST_PLANS,
  },
  {
    name: 'listJobs, a common state, first page',
    statement: { text: LIST_JOBS, params: ['ns', 'q1', '', '{completed}', NOW, 51] },
    indexes: [],
    oneOf: LIST_PLANS,
  },
  {
    name: 'listJobs, a rare state, first page',
    statement: { text: LIST_JOBS, params: ['ns', 'q1', '', '{failed}', NOW, 51] },
    indexes: [],
    oneOf: LIST_PLANS,
  },
  {
    name: 'listJobs, claimable states, a deep cursor',
    statement: {
      text: LIST_JOBS,
      params: ['ns', 'q1', 'j15000', '{waiting,prioritized}', NOW, 51],
    },
    indexes: [],
    oneOf: LIST_PLANS,
  },
  {
    name: 'a job by custom id',
    statement: { text: JOB_BY_ID, params: ['ns', 'j42-q1', 'q1'] },
    indexes: ['qcloud_jobs_pkey'],
  },
  ...JOB_STATES.flatMap((state): Planned[] => {
    const indexes =
      {
        waiting: 'qcloud_jobs_ready_idx',
        prioritized: 'qcloud_jobs_ready_idx',
        delayed: 'qcloud_jobs_delayed_idx',
      }[state as 'waiting'] ?? 'qcloud_jobs_state_idx';
    return [
      {
        name: `${state} jobs of a queue, first page`,
        statement: listing(state),
        indexes: [indexes],
        ordered: true,
      },
      {
        name: `${state} jobs of a queue, a deep page`,
        statement: listing(state, 1_000),
        indexes: [indexes],
        ordered: true,
      },
      {
        name: `how many ${state} jobs a queue has`,
        statement: countInState(state, 'ns', 'q1', NOW),
        indexes: [indexes],
      },
    ];
  }),
];

describeDb('read models: query plans on a seeded table', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
    await migrate(fresh.db);
    // Per queue, one job in ten is waiting, prioritized, delayed, waiting-children, active or failed,
    // and four in ten are completed: a table in which the terminal states dominate, as in production.
    for (const namespace of ['ns', 'other']) {
      for (let queue = 1; queue <= 5; queue++) {
        await fresh.sql.unsafe(`
          INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, run_at, created_at,
                                   lease_until, completed_at)
          SELECT '${namespace}', 'j' || g || '-q${queue}', 'q${queue}', '\\x00'::bytea,
                 (ARRAY['waiting', 'prioritized', 'delayed', 'waiting-children', 'active', 'failed',
                        'completed', 'completed', 'completed', 'completed'])[1 + g % 10],
                 CASE WHEN g % 10 = 1 THEN 1 + g % 5 ELSE 0 END,
                 CASE WHEN g % 10 = 2 THEN ${NOW} + g ELSE g END,
                 g, CASE WHEN g % 10 = 4 THEN ${NOW} + g END, CASE WHEN g % 10 >= 5 THEN g END
          FROM generate_series(1, 20000) g`);
      }
    }
    // A small queue whose ids sort after all the others', so reading it by id has to skip the rest.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, run_at, created_at)
      SELECT 'ns', 'tiny-' || g, 'tiny', '\\x00'::bytea, 'waiting', 0, g, g FROM generate_series(1, 30) g`);
    // A queue is a row of its own; a namespace with thousands of queues, most of them idle.
    for (const namespace of ['ns', 'other']) {
      await fresh.sql.unsafe(`
        INSERT INTO qcloud_queue_state (namespace, queue, paused)
        SELECT '${namespace}', 'q' || g, g % 50 = 0 FROM generate_series(1, 3000) g
        ON CONFLICT DO NOTHING`);
    }
    await fresh.sql.unsafe('VACUUM ANALYZE qcloud_jobs');
    await fresh.sql.unsafe('ANALYZE qcloud_queue_state');
  }, 120_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  test('the seeded table is the size the plans are meant for', async () => {
    const [row] = await fresh.sql<
      Array<{ total: string }>
    >`SELECT count(*) AS total FROM qcloud_jobs`;
    expect(Number(row!.total)).toBe(200_030);
  });

  test.each(PLANNED.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    await checkPlanned(fresh, entry);
  });

  test('a page of any state reads about a page of index entries, not the table', async () => {
    for (const state of JOB_STATES) {
      // Rows the scan returned plus the ones its filter threw away: the entries it had to visit.
      expect(visited(await explain(fresh, listing(state)), 'qcloud_jobs')).toBeLessThan(500);
    }
  });

  test('a page of listJobs walks the primary key for about the share of the queue in a page', async () => {
    // One queue in five: the walk skips the other queues' ids, so about five entries per job returned.
    const nodes = await explain(fresh, {
      text: LIST_JOBS,
      params: ['ns', 'q1', '', null, NOW, 51],
    });
    expect(visited(nodes, 'qcloud_jobs')).toBeLessThan(500);
  });
});
