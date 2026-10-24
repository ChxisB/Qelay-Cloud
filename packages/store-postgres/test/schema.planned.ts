import { PLANNED_DEPLOYMENT } from './schema.planned.deployment';
import { PLANNED_FLOW } from './schema.planned.flow';
import { PLANNED_INBOUND } from './schema.planned.inbound';
import { PLANNED_OPERATOR } from './schema.planned.operator';
import { PLANNED_WEBHOOK } from './schema.planned.webhook';
import { PLANNED_WORKFLOW } from './schema.planned.workflow';

export const READY = `state IN ('waiting', 'prioritized', 'delayed')`;
export const JOB = `namespace = 'ns' AND queue = 'q'`;

export interface Planned {
  /** The query the store runs. */
  readonly query: string;
  readonly sql: string;
  readonly index: string;
  /** Indexes that serve the query as well as `index`: the planner may take either, and either passes. */
  readonly alternatives?: readonly string[];
  /** The index must deliver the order, so the plan has no Sort node. */
  readonly ordered?: boolean;
  /** Values for `$1`, `$2`... when `sql` is a statement of the store that takes parameters. */
  readonly params?: readonly unknown[];
  /** Indexes the plan must not read: a plan that is correct but walks a whole queue to answer. */
  readonly avoid?: readonly string[];
}

/**
 * Every query path of tasks 12-15 (the tick's included) and 18, and the index that serves it. The
 * operator's (drain, clean, flow guard, job details, obliterate) are in `schema.planned.operator.ts`. The check is
 * `EXPLAIN` with sequential scans disabled on a seeded table: an index that the query's shape cannot
 * use (a predicate that does not imply the index's `WHERE`, an `ORDER BY` in another direction)
 * fails here, whatever the planner thinks of table sizes. It is not a performance test: task 22 does
 * the load check.
 */
export const PLANNED: readonly Planned[] = [
  {
    query: 'claim, FIFO: ready ungrouped jobs by priority, then age',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND group_id IS NULL AND NOT lifo AND ${READY}
          AND run_at <= 5000 ORDER BY priority DESC, run_at, id LIMIT 10`,
    index: 'qcloud_jobs_ready_idx',
    ordered: true,
  },
  {
    query: 'claim, LIFO: ready ungrouped LIFO jobs by priority, newest first',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND group_id IS NULL AND lifo AND ${READY}
          AND run_at <= 5000 ORDER BY priority DESC, id DESC LIMIT 10`,
    index: 'qcloud_jobs_lifo_ready_idx',
    ordered: true,
  },
  {
    query: 'claim, grouped: the next ready job of one group',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND group_id = 'g1' AND ${READY} AND run_at <= 5000
          ORDER BY priority, run_at, group_order, id LIMIT 10`,
    index: 'qcloud_jobs_group_ready_idx',
    ordered: true,
  },
  {
    query: 'group concurrency: active jobs of a group',
    sql: `SELECT count(*) FROM qcloud_jobs WHERE ${JOB} AND group_id = 'g1' AND state = 'active'`,
    index: 'qcloud_jobs_group_active_idx',
  },
  {
    query: 'lease recovery: active jobs whose lease ran out, oldest first',
    sql: `SELECT id FROM qcloud_jobs WHERE namespace = 'ns' AND state = 'active' AND lease_until < 5000
          ORDER BY lease_until, id LIMIT 100`,
    index: 'qcloud_jobs_lease_idx',
    ordered: true,
  },
  {
    query: 'listing a queue by state, oldest first',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND state = 'completed' ORDER BY created_at, id LIMIT 50`,
    index: 'qcloud_jobs_state_idx',
    ordered: true,
  },
  {
    query: 'flow: the children of a parent',
    sql: `SELECT id FROM qcloud_jobs WHERE namespace = 'ns' AND parent_id = 'p1'`,
    index: 'qcloud_jobs_parent_idx',
  },
  {
    query: 'TTL expiry: unclaimed jobs past their ttl, oldest first',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND ttl IS NOT NULL AND ${READY}
          AND created_at + ttl < 5000 ORDER BY created_at, id LIMIT 100`,
    index: 'qcloud_jobs_ttl_pending_idx',
    ordered: true,
  },
  {
    query: 'deduplication: the live job holding a unique key',
    sql: `SELECT id FROM qcloud_jobs WHERE ${JOB} AND unique_key = 'k1'
          AND state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')`,
    index: 'qcloud_jobs_live_unique_key_idx',
  },
  {
    query: 'ring query: pending jobs that were never rung and are claimable or inside the window',
    sql: `SELECT id, run_at FROM qcloud_jobs WHERE ${JOB} AND rung_at IS NULL AND ${READY}
          AND run_at <= 5000 AND created_at <= 4000 ORDER BY run_at, id LIMIT 100`,
    index: 'qcloud_jobs_unrung_idx',
    ordered: true,
  },
  {
    query: 'ring query: claimable jobs whose bell is older than the threshold, oldest bell first',
    sql: `SELECT id, run_at FROM qcloud_jobs WHERE ${JOB} AND ${READY} AND rung_at <= 4000
          AND run_at <= 5000 ORDER BY rung_at, id LIMIT 100`,
    index: 'qcloud_jobs_ring_idx',
    ordered: true,
  },
  {
    query: 'ring query: the next queue that has pending jobs (a hop through the queues)',
    sql: `SELECT queue FROM qcloud_jobs WHERE namespace = 'ns' AND ${READY} AND queue > 'a'
          ORDER BY queue LIMIT 1`,
    index: 'qcloud_jobs_ring_idx',
    ordered: true,
  },
  {
    query: 'promotion: delayed jobs whose time has come, oldest first',
    sql: `SELECT id, run_at FROM qcloud_jobs WHERE ${JOB} AND state = 'delayed' AND run_at <= 5000
          ORDER BY run_at, id LIMIT 1001`,
    index: 'qcloud_jobs_delayed_idx',
    ordered: true,
  },
  {
    query: 'promotion: the next queue that has delayed jobs (a hop through the queues)',
    sql: `SELECT queue FROM qcloud_jobs WHERE namespace = 'ns' AND state = 'delayed' AND queue > 'a'
          ORDER BY queue LIMIT 1`,
    index: 'qcloud_jobs_delayed_idx',
    ordered: true,
  },
  {
    query: 'flow: dependencies a job waits for',
    sql: `SELECT dependency_id FROM qcloud_dependencies WHERE namespace = 'ns' AND job_id = 'j1'`,
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow: jobs waiting on a dependency',
    sql: `SELECT job_id FROM qcloud_dependencies WHERE namespace = 'ns' AND dependency_id = 'j1'`,
    index: 'qcloud_dependencies_dependency_idx',
  },
  {
    query: 'flow: children of a parent by failure mode',
    sql: `SELECT child_id FROM qcloud_flow_failures WHERE namespace = 'ns' AND parent_id = 'p1' AND mode = 'fail'`,
    index: 'qcloud_flow_failures_parent_idx',
  },
  {
    query: 'repeat: the job that replaced one',
    sql: `SELECT original_id FROM qcloud_repeat_links WHERE namespace = 'ns' AND successor_id = 'j1'`,
    index: 'qcloud_repeat_links_successor_idx',
  },
  {
    query: 'job logs: a job in order',
    sql: `SELECT message FROM qcloud_job_logs WHERE namespace = 'ns' AND job_id = 'j1' ORDER BY id LIMIT 100`,
    index: 'qcloud_job_logs_job_idx',
    ordered: true,
  },
  {
    query: 'cron: schedules that are due',
    sql: `SELECT name FROM qcloud_crons WHERE namespace = 'ns' AND next_run <= 5000 ORDER BY next_run, name LIMIT 100`,
    index: 'qcloud_crons_due_idx',
    ordered: true,
  },
  {
    query: 'run window: queues whose window has ended, soonest first',
    sql: `SELECT queue FROM qcloud_queue_state WHERE namespace = 'ns' AND run_window IS NOT NULL
          AND window_until <= 5000 ORDER BY window_until LIMIT 100`,
    index: 'qcloud_queue_state_window_idx',
    ordered: true,
  },
  {
    query: 'workers: is a live worker serving a queue (one namespace, a fleet-sized table)',
    sql: `SELECT 1 FROM qcloud_workers WHERE namespace = 'ns' AND 'q' = ANY(queues) AND last_seen > 5000`,
    index: 'qcloud_workers_pkey',
  },
  {
    query: 'tick state: the lease and the last tick of one namespace (one row per namespace)',
    sql: `SELECT leader, leader_expires_at, last_success_at FROM qcloud_tick_state WHERE namespace = 'ns'`,
    index: 'qcloud_tick_state_pkey',
  },
  {
    query: 'completions: a queue’s completed ids',
    sql: `SELECT job_id FROM qcloud_completions WHERE namespace = 'ns' AND queue = 'q' ORDER BY job_id LIMIT 100`,
    index: 'qcloud_completions_queue_idx',
    ordered: true,
  },
  {
    query: 'completions: the most recent first',
    sql: `SELECT job_id FROM qcloud_completions WHERE namespace = 'ns' ORDER BY completed_at DESC, job_id DESC LIMIT 100`,
    index: 'qcloud_completions_recent_idx',
    ordered: true,
  },
  {
    query: 'groups: rotation order within a queue',
    sql: `SELECT group_id FROM qcloud_group_state WHERE namespace = 'ns' AND queue = 'q' ORDER BY last_served, group_id LIMIT 10`,
    index: 'qcloud_group_state_rotation_idx',
    ordered: true,
  },
  {
    query: 'events: the latest of a queue',
    sql: `SELECT id FROM qcloud_events WHERE namespace = 'ns' AND queue = 'q' ORDER BY id DESC LIMIT 100`,
    index: 'qcloud_events_queue_id_idx',
    ordered: true,
  },
  {
    query: 'events: a namespace after a cursor',
    sql: `SELECT id FROM qcloud_events WHERE namespace = 'ns' AND id > 100 ORDER BY id LIMIT 100`,
    index: 'qcloud_events_namespace_id_idx',
    ordered: true,
  },
  {
    query: 'events: the rows of one transaction',
    sql: `SELECT id FROM qcloud_events WHERE namespace = 'ns' AND transaction_id = 7 ORDER BY id`,
    index: 'qcloud_events_transaction_idx',
    ordered: true,
  },
  {
    query: 'commits: replay in commit order after a cursor',
    sql: `SELECT transaction_id FROM qcloud_event_commits WHERE namespace = 'ns' AND commit_seq > 5
          ORDER BY commit_seq, transaction_id LIMIT 100`,
    index: 'qcloud_event_commits_replay_idx',
    ordered: true,
  },
  {
    query: 'commits: the window of envelopes a prune pass examines after its cursor',
    sql: `SELECT namespace, transaction_id, commit_seq FROM qcloud_event_commits
          WHERE namespace = 'ns' AND commit_seq IS NOT NULL AND commit_seq > 5
          ORDER BY commit_seq LIMIT 2000`,
    index: 'qcloud_event_commits_replay_idx',
    ordered: true,
  },
  {
    query: 'retention counts: the unfolded counts of one queue, consumed by key',
    sql: `DELETE FROM qcloud_event_retention_deltas WHERE namespace = 'ns' AND queue = 'q'
          RETURNING delta_count, last_event_id`,
    index: 'qcloud_event_retention_deltas_pkey',
  },
  {
    query: 'prune watermarks: the newest committed of a queue',
    sql: `SELECT commit_seq FROM qcloud_event_prune_watermarks WHERE namespace = 'ns' AND queue = 'q'
          AND commit_seq IS NOT NULL ORDER BY commit_seq DESC LIMIT 1`,
    index: 'qcloud_event_prune_watermarks_commit_idx',
    ordered: true,
  },
  {
    query: 'prune watermarks: those of a transaction still waiting for a commit number',
    sql: `SELECT source_event_id FROM qcloud_event_prune_watermarks WHERE namespace = 'ns'
          AND transaction_id = 7 AND commit_seq IS NULL`,
    index: 'qcloud_event_prune_watermarks_pending_commit_idx',
  },
  ...PLANNED_OPERATOR,
  ...PLANNED_FLOW,
  ...PLANNED_DEPLOYMENT,
  ...PLANNED_WEBHOOK,
  ...PLANNED_INBOUND,
  ...PLANNED_WORKFLOW,
];
