import type { JobState } from '@qelay-cloud/core';
import { JOB_STATES } from '@qelay-cloud/core';

/**
 * The SQL of the read models, as text with positional parameters. The store runs these exact
 * strings (`sql.unsafe(text, params)`) and the plan test (`read.plans.test.ts`) puts `EXPLAIN` in
 * front of the same strings, so "every read-model query has an index-backed plan" is checked on
 * what runs, not on a copy of it. No value is interpolated: states are fixed words from this file.
 *
 * A job's effective state (what a reader reports) differs from its stored one in one way: a stored
 * `waiting`, `prioritized` or `delayed` row is `delayed` while its `run_at` is ahead of now,
 * `prioritized` when it is claimable with a priority, and `waiting` otherwise (`effectiveState` in
 * `state.ts`). The counts therefore read the pending states from `qcloud_jobs_ready_idx`, which holds
 * exactly the columns that decide it (`priority`, `run_at`) and is partial on the pending states, and
 * the other states from `qcloud_jobs_state_idx`. Both are index-only scans.
 */

const PENDING = `'waiting', 'prioritized', 'delayed'`;
const OTHER = `'waiting-children', 'active', 'completed', 'failed'`;

/** Columns `toRecord` reads. */
export const JOB_COLUMNS = `id, queue, payload, state, priority, attempts, max_attempts, run_at,
  created_at, lease_owner, lease_until`;

/** Rows `(state, total)` of one queue. Parameters: namespace, queue, now. */
export const COUNTS_BY_STATE = `
  SELECT state, count(*)::bigint AS total FROM (
    SELECT CASE WHEN run_at > $3 THEN 'delayed' WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END AS state
    FROM qcloud_jobs WHERE namespace = $1 AND queue = $2 AND state IN (${PENDING})
    UNION ALL
    SELECT state FROM qcloud_jobs WHERE namespace = $1 AND queue = $2 AND state IN (${OTHER})
  ) counted GROUP BY state`;

/**
 * Rows `(priority, total)` of one queue's jobs that a worker could claim now. Parameters: namespace,
 * queue, now. Read from `qcloud_jobs_ready_idx` alone, like the counts by state.
 */
export const PRIORITY_COUNTS = `
  SELECT priority, count(*)::bigint AS total FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND state IN (${PENDING}) AND run_at <= $3
  GROUP BY priority`;

/** Rows `(state, total)` of the whole namespace. Parameters: namespace, now. */
export const DASHBOARD_COUNTS = `
  SELECT state, count(*)::bigint AS total FROM (
    SELECT CASE WHEN run_at > $2 THEN 'delayed' WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END AS state
    FROM qcloud_jobs WHERE namespace = $1 AND state IN (${PENDING})
    UNION ALL
    SELECT state FROM qcloud_jobs WHERE namespace = $1 AND state IN (${OTHER})
  ) counted GROUP BY state`;

/** One row `(queues, paused)`. Parameters: namespace. */
export const QUEUE_TOTALS = `
  SELECT count(*)::bigint AS queues, (count(*) FILTER (WHERE paused))::bigint AS paused
  FROM qcloud_queue_state WHERE namespace = $1`;

/**
 * Rows `(queue, paused, state, total)` for a page of queues, by name, each with its counts; a queue
 * with no jobs has one row with a null state. Parameters: namespace, the queue to start after ('' for
 * the first page), the page size plus one, now.
 */
export const QUEUE_SUMMARIES = `
  SELECT page.queue, page.paused, counted.state, counted.total
  FROM (
    SELECT queue, paused FROM qcloud_queue_state
    WHERE namespace = $1 AND queue > $2
    ORDER BY queue LIMIT $3
  ) page
  LEFT JOIN LATERAL (
    SELECT state, count(*)::bigint AS total FROM (
      SELECT CASE WHEN run_at > $4 THEN 'delayed' WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END AS state
      FROM qcloud_jobs WHERE namespace = $1 AND queue = page.queue AND state IN (${PENDING})
      UNION ALL
      SELECT state FROM qcloud_jobs WHERE namespace = $1 AND queue = page.queue AND state IN (${OTHER})
    ) inner_counted GROUP BY state
  ) counted ON TRUE
  ORDER BY page.queue`;

/** One row. Parameters: namespace, id, queue. A job's id is its custom id when it has one. */
export const JOB_BY_ID = `
  SELECT ${JOB_COLUMNS} FROM qcloud_jobs WHERE namespace = $1 AND id = $2 AND queue = $3`;

/** A statement and the parameters it takes, in order. */
export interface Statement {
  readonly text: string;
  readonly params: readonly (string | number | null)[];
}

/**
 * `listJobs`, the cursor read of the `StateStore` contract: a queue's jobs by id (ids sort in creation
 * order), optionally only in some states (`$4` is a Postgres array literal of state names, or null for
 * every state). Parameters: namespace, queue, the id to start after ('' for the first page), the
 * states, now, the page size plus one.
 *
 * The primary key is `(namespace, id)`, so the planner walks it in id order and filters on the queue,
 * or, for a small queue or a state it finds selective, reads that queue's rows through
 * `qcloud_jobs_state_idx` and sorts them. Either is index-backed and bounded: by the page and the
 * queue's share of the namespace, or by the size of the queue's rows in the states asked for, which
 * retention bounds. Control reads of one state use `jobsInState` instead, which an index orders.
 */
export const LIST_JOBS = `
  SELECT ${JOB_COLUMNS} FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND id > $3
    AND ($4::text[] IS NULL OR (CASE
      WHEN state IN (${PENDING}) THEN
        CASE WHEN run_at > $5 THEN 'delayed' WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END
      ELSE state END) = ANY($4::text[]))
  ORDER BY id LIMIT $6`;

export interface StateScan {
  /** The rows of the state; `{now}` stands for the parameter holding now, and is given only if it appears. */
  readonly where: string;
  readonly order: string;
}

/**
 * Each state's rows and the order a reader wants them in, chosen so an index delivers it:
 * the claimable states in claim order (`qcloud_jobs_ready_idx`), delayed jobs by when they are due
 * (`qcloud_jobs_delayed_idx`), the rest newest first (`qcloud_jobs_state_idx`, read backwards).
 *
 * `delayed` reads stored `delayed` rows only. Every path that makes a job pending computes its state
 * from `run_at` (`initialState`) or lowers `run_at` to now (`release`), so a stored `waiting` or
 * `prioritized` row never has a `run_at` ahead of now, and the effective `delayed` rows are a subset
 * of the stored ones. `read.models.test.ts` checks that a listing agrees with the counts.
 */
const SCANS: Readonly<Record<JobState, StateScan>> = {
  waiting: {
    where: `state IN (${PENDING}) AND run_at <= {now} AND priority = 0`,
    order: 'priority DESC, run_at, id',
  },
  prioritized: {
    where: `state IN (${PENDING}) AND run_at <= {now} AND priority > 0`,
    order: 'priority DESC, run_at, id',
  },
  delayed: { where: `state = 'delayed' AND run_at > {now}`, order: 'run_at, id' },
  'waiting-children': { where: `state = 'waiting-children'`, order: 'created_at DESC, id DESC' },
  active: { where: `state = 'active'`, order: 'created_at DESC, id DESC' },
  completed: { where: `state = 'completed'`, order: 'created_at DESC, id DESC' },
  failed: { where: `state = 'failed'`, order: 'created_at DESC, id DESC' },
};

export function scanOf(state: JobState): StateScan {
  const scan = JOB_STATES.includes(state) ? SCANS[state] : undefined;
  if (!scan) throw new Error(`unknown job state: ${String(state)}`);
  return scan;
}

/** Namespace and queue first, then now only if the state's rows depend on it, then what `extra` adds. */
function scanned(
  state: JobState,
  namespace: string,
  queue: string,
  now: number,
  extra: readonly number[]
): { where: string; order: string; params: (string | number)[]; next: number } {
  const { where, order } = scanOf(state);
  const usesNow = where.includes('{now}');
  return {
    where: where.replace('{now}', '$3'),
    order,
    params: [namespace, queue, ...(usesNow ? [now] : []), ...extra],
    next: usesNow ? 4 : 3,
  };
}

/** One page of a queue's jobs in a state. */
export function jobsInState(
  state: JobState,
  namespace: string,
  queue: string,
  now: number,
  limit: number,
  offset: number
): Statement {
  const scan = scanned(state, namespace, queue, now, [limit, offset]);
  return {
    text: `SELECT ${JOB_COLUMNS} FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND ${scan.where}
  ORDER BY ${scan.order} LIMIT $${scan.next} OFFSET $${scan.next + 1}`,
    params: scan.params,
  };
}

/** How many jobs `jobsInState` pages over. */
export function countInState(
  state: JobState,
  namespace: string,
  queue: string,
  now: number
): Statement {
  const scan = scanned(state, namespace, queue, now, []);
  return {
    text: `SELECT count(*)::bigint AS total FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND ${scan.where}`,
    params: scan.params,
  };
}

/** A job's log lines, oldest first. Parameters: namespace, job id, limit. */
export const JOB_LOGS = `
  SELECT timestamp, level, message FROM qcloud_job_logs
  WHERE namespace = $1 AND job_id = $2
  ORDER BY id LIMIT $3`;

/**
 * Rows `(metric_type, minute, count)` of one queue's minute buckets from `$3` to `$4`, both included.
 * Parameters: namespace, queue, first minute, last minute. The primary key is
 * `(namespace, queue, metric_type, minute)`: the two types are an index condition and the minutes a range.
 */
export const THROUGHPUT_BUCKETS = `
  SELECT metric_type, minute, count FROM qcloud_metric_buckets
  WHERE namespace = $1 AND queue = $2 AND metric_type IN ('completed', 'failed')
    AND minute BETWEEN $3 AND $4
  ORDER BY metric_type, minute`;

/** Rows `(metric_type, total_count)` of one queue's lifetime totals. Parameters: namespace, queue. */
export const THROUGHPUT_TOTALS = `
  SELECT metric_type, total_count FROM qcloud_metric_totals
  WHERE namespace = $1 AND queue = $2`;

/**
 * Rows `(metric_type, total)` of the lifetime totals of every queue of the namespace, summed. One
 * row of the table per queue and type, read by the primary key's `namespace` prefix. Parameters: namespace.
 */
export const NAMESPACE_TOTALS = `
  SELECT metric_type, sum(total_count)::bigint AS total FROM qcloud_metric_totals
  WHERE namespace = $1 GROUP BY metric_type`;
