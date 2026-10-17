import { StoreError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { PlannedInsert, Plan } from './plan';

const INSERT_CHUNK = 1000;

/** Releases dedup keys: the job stays, without a key. Upstream's `clearPostgresDeduplication`. */
async function clearKeys(tx: TransactionSQL, namespace: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  await tx`
    UPDATE qcloud_jobs
    SET unique_key = NULL, unique_expires_at = NULL, version = version + 1
    WHERE namespace = ${namespace} AND id = ANY(${tx.array([...new Set(ids)], 'TEXT')})`;
}

/** Moves dedup windows: upstream's `extendPostgresDeduplication`. */
async function extendWindows(
  tx: TransactionSQL,
  namespace: string,
  extend: ReadonlyMap<string, number>
) {
  if (extend.size === 0) return;
  await tx`
    UPDATE qcloud_jobs AS job
    SET unique_expires_at = moved.expires_at, version = job.version + 1
    FROM unnest(${tx.array([...extend.keys()], 'TEXT')},
                ${tx.array([...extend.values()], 'BIGINT')}) AS moved(id, expires_at)
    WHERE job.namespace = ${namespace} AND job.id = moved.id`;
}

/**
 * Deletes finished or replaced generations: the job row and every row that hangs off it. Upstream's
 * `deleteTerminalGeneration`, as one statement for the whole set. The DLQ entry is a column of the
 * job row, so it goes with it.
 */
async function deleteGenerations(tx: TransactionSQL, namespace: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  const gone = tx.array([...new Set(ids)], 'TEXT');
  await tx`
    WITH gone AS MATERIALIZED (SELECT unnest(${gone}) AS id),
    logs AS (
      DELETE FROM qcloud_job_logs WHERE namespace = ${namespace}
        AND job_id IN (SELECT id FROM gone)),
    links AS (
      DELETE FROM qcloud_repeat_links WHERE namespace = ${namespace}
        AND (original_id IN (SELECT id FROM gone) OR successor_id IN (SELECT id FROM gone))),
    failures AS (
      DELETE FROM qcloud_flow_failures WHERE namespace = ${namespace}
        AND parent_id IN (SELECT id FROM gone)),
    dependencies AS (
      DELETE FROM qcloud_dependencies WHERE namespace = ${namespace}
        AND job_id IN (SELECT id FROM gone)),
    completions AS (
      DELETE FROM qcloud_completions WHERE namespace = ${namespace}
        AND job_id IN (SELECT id FROM gone))
    DELETE FROM qcloud_jobs WHERE namespace = ${namespace} AND id IN (SELECT id FROM gone)`;
}

/**
 * `group_order` values for the grouped inserts, taken from the sequence in input order, so a
 * group's FIFO order is the order its jobs were enqueued in.
 */
async function allocateGroupOrders(
  tx: TransactionSQL,
  inserts: readonly PlannedInsert[]
): Promise<Map<number, string>> {
  const positions = inserts.flatMap((insert, position) =>
    insert.job.groupId === null ? [] : [position]
  );
  if (positions.length === 0) return new Map();
  const rows = await tx<Array<{ position: number; group_order: number | string | bigint }>>`
    WITH ordered AS MATERIALIZED (
      SELECT position FROM unnest(${tx.array(positions, 'INTEGER')}) AS requested(position)
      ORDER BY position
    )
    SELECT position, nextval('qcloud_group_order_seq') AS group_order
    FROM ordered
    ORDER BY position`;
  return new Map(rows.map((row) => [row.position, String(row.group_order)]));
}

async function insertJobs(
  tx: TransactionSQL,
  namespace: string,
  inserts: readonly PlannedInsert[],
  now: number
) {
  if (inserts.length === 0) return;
  const orders = await allocateGroupOrders(tx, inserts);
  const records = inserts.map(({ job, id, state, runAt, uniqueExpiresAt }, position) => ({
    namespace,
    id,
    queue: job.queue,
    payload: Buffer.from(job.payload.buffer, job.payload.byteOffset, job.payload.byteLength),
    state,
    priority: job.priority,
    lifo: job.lifo,
    run_at: runAt,
    created_at: now,
    max_attempts: job.maxAttempts,
    timeout: job.timeout,
    unique_key: job.dedupKey,
    unique_expires_at: uniqueExpiresAt,
    custom_id: job.customId,
    group_id: job.groupId,
    group_order: orders.get(position) ?? null,
  }));
  let inserted = 0;
  for (let offset = 0; offset < records.length; offset += INSERT_CHUNK) {
    const chunk = records.slice(offset, offset + INSERT_CHUNK);
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO qcloud_jobs ${tx(
        chunk,
        'namespace',
        'id',
        'queue',
        'payload',
        'state',
        'priority',
        'lifo',
        'run_at',
        'created_at',
        'max_attempts',
        'timeout',
        'unique_key',
        'unique_expires_at',
        'custom_id',
        'group_id',
        'group_order'
      )}
      ON CONFLICT DO NOTHING
      RETURNING id`;
    inserted += rows.length;
  }
  if (inserted !== inserts.length) {
    // The locks make this unreachable by two enqueues; a conflict means a row appeared by another
    // route (a manual insert, a UUID collision). Rolling back beats returning a job that is not there.
    throw new StoreError(
      `enqueue inserted ${inserted} of ${inserts.length} jobs: an id or dedup key was taken ` +
        'by a row admission did not see. Nothing was admitted.'
    );
  }
}

/** Writes a plan, in the order the rules need: release and extend, delete, then insert. */
export async function applyPlan(
  tx: TransactionSQL,
  namespace: string,
  plan: Plan,
  now: number
): Promise<void> {
  await clearKeys(tx, namespace, plan.clearKeyIds);
  await extendWindows(tx, namespace, plan.extend);
  await deleteGenerations(tx, namespace, plan.deleteIds);
  await insertJobs(tx, namespace, plan.inserts, now);
}
