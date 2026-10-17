import type { TransactionSQL } from 'bun';
import type { GroupRef } from './locks';

/** The columns of an existing job that admission decides on. */
export interface ExistingRow {
  readonly id: string;
  readonly queue: string;
  /** The stored state: a `delayed` row may already be due. */
  readonly state: string;
  readonly runAt: number;
  readonly priority: number;
  readonly groupId: string | null;
  readonly uniqueKey: string | null;
  readonly uniqueExpiresAt: number | null;
}

interface RawRow {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly run_at: number | string | bigint;
  readonly priority: number;
  readonly group_id: string | null;
  readonly unique_key: string | null;
  readonly unique_expires_at: number | string | bigint | null;
}

const COLUMNS = `id, queue, state, run_at, priority, group_id, unique_key, unique_expires_at`;

export const keyOf = (queue: string, key: string) => `${queue}\u0000${key}`;

function toExisting(row: RawRow): ExistingRow {
  return {
    id: row.id,
    queue: row.queue,
    state: row.state,
    runAt: Number(row.run_at),
    priority: row.priority,
    groupId: row.group_id,
    uniqueKey: row.unique_key,
    uniqueExpiresAt: row.unique_expires_at === null ? null : Number(row.unique_expires_at),
  };
}

/**
 * The rows with these ids, locked, whatever their state. A row that is not here does not exist:
 * the admission-key locks are already held, so no other enqueue can be creating it.
 */
export async function findById(
  tx: TransactionSQL,
  namespace: string,
  ids: readonly string[]
): Promise<Map<string, ExistingRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<RawRow[]>`
    SELECT ${tx.unsafe(COLUMNS)} FROM qcloud_jobs
    WHERE namespace = ${namespace} AND id = ANY(${tx.array([...ids], 'TEXT')})
    FOR UPDATE`;
  return new Map(rows.map((row) => [row.id, toExisting(row)]));
}

/**
 * The live jobs holding these dedup keys, locked, by `keyOf(queue, key)`. The live unique index
 * allows at most one per key.
 */
export async function findLiveByKey(
  tx: TransactionSQL,
  namespace: string,
  keys: ReadonlyArray<{ readonly queue: string; readonly key: string }>
): Promise<Map<string, ExistingRow>> {
  if (keys.length === 0) return new Map();
  const rows = await tx<RawRow[]>`
    SELECT j.id, j.queue, j.state, j.run_at, j.priority, j.group_id, j.unique_key,
           j.unique_expires_at
    FROM unnest(${tx.array(
      keys.map((k) => k.queue),
      'TEXT'
    )},
                ${tx.array(
                  keys.map((k) => k.key),
                  'TEXT'
                )}) AS wanted(queue, unique_key)
    JOIN qcloud_jobs j
      ON j.namespace = ${namespace} AND j.queue = wanted.queue AND j.unique_key = wanted.unique_key
     AND j.state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')
    FOR UPDATE OF j`;
  return new Map(rows.map((row) => [keyOf(row.queue, row.unique_key!), toExisting(row)]));
}

/** Pending jobs (waiting, prioritized, delayed) per group, by `keyOf(queue, groupId)`. */
export async function countPendingByGroup(
  tx: TransactionSQL,
  namespace: string,
  groups: readonly GroupRef[]
): Promise<Map<string, number>> {
  // One row per group: a group named by several jobs of the call would otherwise join, and count, once per mention.
  const distinct = [...new Map(groups.map((g) => [keyOf(g.queue, g.groupId), g])).values()];
  if (distinct.length === 0) return new Map();
  const rows = await tx<Array<{ queue: string; group_id: string; pending: number }>>`
    SELECT wanted.queue, wanted.group_id, count(j.id)::int AS pending
    FROM unnest(${tx.array(
      distinct.map((g) => g.queue),
      'TEXT'
    )},
                ${tx.array(
                  distinct.map((g) => g.groupId),
                  'TEXT'
                )}) AS wanted(queue, group_id)
    LEFT JOIN qcloud_jobs j
      ON j.namespace = ${namespace} AND j.queue = wanted.queue AND j.group_id = wanted.group_id
     AND j.state IN ('waiting', 'prioritized', 'delayed')
    GROUP BY wanted.queue, wanted.group_id`;
  return new Map(rows.map((row) => [keyOf(row.queue, row.group_id), row.pending]));
}
