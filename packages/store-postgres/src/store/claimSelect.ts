import type { GroupPullOptions } from '@qelay-cloud/core';
import type { SQL, TransactionSQL } from 'bun';

/**
 * Which jobs a claim takes. Adapted from Qelay's `claimSelection.ts` and `groupClaims.ts`; see
 * docs/PORTING.md for what differs. Dependency filters and TTL expiry are not here: flows are
 * task 50 and expiry is the tick (task 15), so no row in `qcloud_jobs` needs either today.
 *
 * A stored `delayed` row whose `run_at` has passed is claimable (the tick promotes it later), so
 * every query takes the pending states and `run_at <= now`.
 */

export interface CandidateRow {
  readonly id: string;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly priority: number;
  readonly attempts: number;
  readonly timeout: number | string | bigint | null;
  readonly group_id: string | null;
}

const COLUMNS = 'id, queue, payload, priority, attempts, timeout, group_id';
const JOB_COLUMNS = COLUMNS.split(', ')
  .map((column) => `job.${column}`)
  .join(', ');

export async function hasClaimableGroup(
  tx: SQL,
  namespace: string,
  queue: string,
  now: number
): Promise<boolean> {
  const [row] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM qcloud_jobs AS job
      LEFT JOIN qcloud_group_state AS groups
        ON groups.namespace = job.namespace AND groups.queue = job.queue
       AND groups.group_id = job.group_id
      WHERE job.namespace = ${namespace} AND job.queue = ${queue}
        AND job.group_id IS NOT NULL
        AND job.state IN ('waiting', 'prioritized', 'delayed')
        AND job.run_at <= ${now}
        AND COALESCE(groups.paused, FALSE) = FALSE
        AND (groups.manual_rate_limit_until IS NULL OR groups.manual_rate_limit_until <= ${now})
    ) AS exists`;
  return row!.exists;
}

/**
 * Ungrouped jobs, in claim order: priority (higher first), then LIFO jobs (newest first), then
 * FIFO jobs (`run_at`, then id). The two kinds are read by two queries, each one ordered by its own
 * partial index and merged here, because one `ORDER BY CASE ...` cannot use either index and would
 * sort the whole backlog. Each query locks the rows it reads (`SKIP LOCKED`, so concurrent
 * claimers take different jobs); the rows read but not taken stay locked until commit.
 */
async function selectUngrouped(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  now: number,
  capacity: number
): Promise<CandidateRow[]> {
  const lifo = await tx<CandidateRow[]>`
    SELECT ${tx.unsafe(COLUMNS)} FROM qcloud_jobs
    WHERE namespace = ${namespace} AND queue = ${queue}
      AND group_id IS NULL AND lifo
      AND state IN ('waiting', 'prioritized', 'delayed') AND run_at <= ${now}
    ORDER BY priority DESC, id DESC
    LIMIT ${capacity}
    FOR UPDATE SKIP LOCKED`;
  const fifo = await tx<CandidateRow[]>`
    SELECT ${tx.unsafe(COLUMNS)} FROM qcloud_jobs
    WHERE namespace = ${namespace} AND queue = ${queue}
      AND group_id IS NULL AND NOT lifo
      AND state IN ('waiting', 'prioritized', 'delayed') AND run_at <= ${now}
    ORDER BY priority DESC, run_at, id
    LIMIT ${capacity}
    FOR UPDATE SKIP LOCKED`;
  return mergeByPriority(lifo, fifo).slice(0, capacity);
}

/** Both inputs are sorted by priority, highest first. At equal priority every LIFO job comes first. */
export function mergeByPriority<T extends { readonly priority: number }>(
  lifo: readonly T[],
  fifo: readonly T[]
): T[] {
  const merged: T[] = [];
  let a = 0;
  let b = 0;
  while (a < lifo.length || b < fifo.length) {
    const takeLifo =
      b >= fifo.length || (a < lifo.length && lifo[a]!.priority >= fifo[b]!.priority);
    merged.push(takeLifo ? lifo[a++]! : fifo[b++]!);
  }
  return merged;
}

/**
 * Grouped jobs: at most one round per group before any group gets a second job, the least
 * recently served group first. A group's own pause, concurrency and rate limit (its
 * `qcloud_group_state` row) win over the defaults in `options`. Within a group the order is
 * `priority` (lower first), `run_at`, the admission sequence, then id.
 */
async function selectGrouped(
  tx: TransactionSQL,
  namespace: string,
  input: { queue: string; now: number; capacity: number; options?: GroupPullOptions }
): Promise<CandidateRow[]> {
  const { queue, now, capacity, options } = input;
  const concurrency = options?.concurrency ?? null;
  const rateMax = options?.limit?.max ?? null;
  const affinity = typeof options?.affinity === 'string' ? options.affinity : null;
  return tx<CandidateRow[]>`
    WITH ready AS (
      SELECT job.id, job.group_id,
        row_number() OVER (
          PARTITION BY job.group_id
          ORDER BY job.priority, job.run_at, job.group_order, job.id
        ) AS group_position
      FROM qcloud_jobs AS job
      WHERE job.namespace = ${namespace} AND job.queue = ${queue}
        AND job.group_id IS NOT NULL
        AND (CAST(${affinity} AS TEXT) IS NULL OR job.group_id = CAST(${affinity} AS TEXT))
        AND job.state IN ('waiting', 'prioritized', 'delayed')
        AND job.run_at <= ${now}
    ), active AS (
      SELECT group_id, COUNT(*)::integer AS count
      FROM qcloud_jobs
      WHERE namespace = ${namespace} AND queue = ${queue}
        AND group_id IS NOT NULL AND state = 'active' AND lease_until > ${now}
      GROUP BY group_id
    ), capacities AS (
      SELECT groups.group_id, groups.last_served,
        LEAST(
          ${capacity},
          CASE WHEN COALESCE(groups.concurrency_limit, CAST(${concurrency} AS BIGINT)) IS NULL
            THEN ${capacity}
            ELSE GREATEST(
              0,
              COALESCE(groups.concurrency_limit, CAST(${concurrency} AS BIGINT))
                - COALESCE(active.count, 0)
            )
          END,
          CASE WHEN COALESCE(groups.rate_limit, CAST(${rateMax} AS BIGINT)) IS NULL
            THEN ${capacity}
            ELSE GREATEST(
              0,
              COALESCE(groups.rate_limit, CAST(${rateMax} AS BIGINT)) - groups.rate_count
            )
          END
        ) AS available
      FROM qcloud_group_state AS groups
      LEFT JOIN active ON active.group_id = groups.group_id
      WHERE groups.namespace = ${namespace} AND groups.queue = ${queue}
        AND groups.paused = FALSE
        AND (groups.manual_rate_limit_until IS NULL OR groups.manual_rate_limit_until <= ${now})
    ), selected AS (
      SELECT ready.id, ready.group_id, ready.group_position, capacities.last_served
      FROM ready JOIN capacities ON capacities.group_id = ready.group_id
      WHERE ready.group_position <= capacities.available
      ORDER BY ready.group_position, capacities.last_served NULLS FIRST, ready.group_id
      LIMIT ${capacity}
    )
    SELECT ${tx.unsafe(JOB_COLUMNS)}
    FROM qcloud_jobs AS job
    JOIN selected ON selected.id = job.id
    WHERE job.namespace = ${namespace}
      AND job.state IN ('waiting', 'prioritized', 'delayed')
      AND job.run_at <= ${now}
    ORDER BY selected.group_position, selected.last_served NULLS FIRST, selected.group_id
    FOR UPDATE OF job SKIP LOCKED`;
}

/**
 * The jobs a claim takes, ungrouped first and the grouped ones after them. `affinity` a group id:
 * only that group's jobs. `affinity` null: no grouped job.
 */
export async function selectCandidates(
  tx: TransactionSQL,
  namespace: string,
  input: { queue: string; now: number; capacity: number; options?: GroupPullOptions }
): Promise<CandidateRow[]> {
  const { queue, now, capacity, options } = input;
  const affinity = options?.affinity;
  const ungrouped =
    typeof affinity === 'string' ? [] : await selectUngrouped(tx, namespace, queue, now, capacity);
  if (ungrouped.length >= capacity || affinity === null) return ungrouped;
  const grouped = await selectGrouped(tx, namespace, {
    queue,
    now,
    capacity: capacity - ungrouped.length,
    options,
  });
  return [...ungrouped, ...grouped];
}
