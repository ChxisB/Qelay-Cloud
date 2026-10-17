import type { GroupPullOptions } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { CandidateRow } from './claimSelect';

/**
 * The per-group side of a claim. Adapted from Qelay's `groupClaims.ts`. All three run in the
 * claim transaction while the queue-state row is locked exclusively, so no other claimer reads or
 * writes a group's counters meanwhile.
 *
 * Fixed here against upstream: a group's own limit applies even when the worker passes no default
 * (upstream skipped the window refresh and the count for it, so such a group was never reset).
 */

/** Gives every pending group without a rotation position one, in order of its first job. */
export async function ensureGroupStates(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  sequence: number
): Promise<number> {
  const assigned = await tx<{ group_id: string }[]>`
    WITH unsequenced AS (
      SELECT job.group_id, MIN(job.group_order) AS first_order
      FROM qcloud_jobs AS job
      LEFT JOIN qcloud_group_state AS groups
        ON groups.namespace = job.namespace AND groups.queue = job.queue
       AND groups.group_id = job.group_id
      WHERE job.namespace = ${namespace} AND job.queue = ${queue}
        AND job.group_id IS NOT NULL AND groups.last_served IS NULL
        AND job.state IN ('waiting', 'prioritized', 'delayed')
      GROUP BY job.group_id
    ), ordered AS (
      SELECT group_id, row_number() OVER (ORDER BY first_order, group_id) AS position
      FROM unsequenced
    )
    INSERT INTO qcloud_group_state (namespace, queue, group_id, last_served)
    SELECT ${namespace}, ${queue}, group_id, ${sequence} + position
    FROM ordered
    ON CONFLICT (namespace, queue, group_id) DO UPDATE
    SET last_served = EXCLUDED.last_served
    WHERE qcloud_group_state.last_served IS NULL
    RETURNING group_id`;
  if (assigned.length === 0) return sequence;
  const next = sequence + assigned.length;
  await tx`
    UPDATE qcloud_queue_state SET group_sequence = ${next}
    WHERE namespace = ${namespace} AND queue = ${queue}`;
  return next;
}

/**
 * Starts a new fixed window for each pending group whose window ran out or whose effective limit
 * changed. A group's own `rate_limit` and `rate_duration_ms` win over the worker default.
 */
export async function refreshGroupRateWindows(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  options: GroupPullOptions | undefined,
  now: number
): Promise<void> {
  const max = options?.limit?.max ?? null;
  const duration = options?.limit?.duration ?? null;
  await tx`
    UPDATE qcloud_group_state AS groups
    SET rate_window_started_at = ${now}, rate_count = 0,
        rate_effective_max = COALESCE(groups.rate_limit, CAST(${max} AS BIGINT)),
        rate_effective_duration_ms =
          COALESCE(groups.rate_duration_ms, CAST(${duration} AS BIGINT), 1000)
    WHERE groups.namespace = ${namespace} AND groups.queue = ${queue}
      AND COALESCE(groups.rate_limit, CAST(${max} AS BIGINT)) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM qcloud_jobs AS job
        WHERE job.namespace = groups.namespace AND job.queue = groups.queue
          AND job.group_id = groups.group_id
          AND job.state IN ('waiting', 'prioritized', 'delayed')
      )
      AND (
        groups.rate_window_started_at IS NULL
        OR groups.rate_effective_max IS DISTINCT FROM COALESCE(groups.rate_limit, CAST(${max} AS BIGINT))
        OR groups.rate_effective_duration_ms IS DISTINCT FROM
             COALESCE(groups.rate_duration_ms, CAST(${duration} AS BIGINT), 1000)
        OR groups.rate_window_started_at
             + COALESCE(groups.rate_duration_ms, CAST(${duration} AS BIGINT), 1000) <= ${now}
      )`;
}

/** Consumes the groups' budgets and moves the round-robin cursor past the groups just served. */
export async function commitGroupClaims(
  tx: TransactionSQL,
  namespace: string,
  input: {
    queue: string;
    rows: readonly CandidateRow[];
    options?: GroupPullOptions;
    sequence: number;
  }
): Promise<void> {
  const { queue, rows, options, sequence } = input;
  const grouped = rows.filter((row) => row.group_id !== null);
  if (grouped.length === 0) return;
  const turns = new Map<string, { last: number; count: number }>();
  grouped.forEach((row, index) => {
    const groupId = row.group_id!;
    turns.set(groupId, {
      last: sequence + index + 1,
      count: (turns.get(groupId)?.count ?? 0) + 1,
    });
  });
  const entries = [...turns.entries()];
  const max = options?.limit?.max ?? null;
  await tx`
    UPDATE qcloud_group_state AS groups
    SET last_served = batch.last_served,
        rate_count = groups.rate_count + CASE
          WHEN COALESCE(groups.rate_limit, CAST(${max} AS BIGINT)) IS NOT NULL
          THEN batch.claimed_count ELSE 0 END
    FROM unnest(
      ${tx.array(
        entries.map(([groupId]) => groupId),
        'TEXT'
      )},
      ${tx.array(
        entries.map(([, value]) => value.last),
        'BIGINT'
      )},
      ${tx.array(
        entries.map(([, value]) => value.count),
        'INTEGER'
      )}
    ) AS batch(group_id, last_served, claimed_count)
    WHERE groups.namespace = ${namespace} AND groups.queue = ${queue}
      AND groups.group_id = batch.group_id`;
  await tx`
    UPDATE qcloud_queue_state SET group_sequence = ${sequence + grouped.length}
    WHERE namespace = ${namespace} AND queue = ${queue}`;
}
