import type { TransactionSQL } from 'bun';

/**
 * Advisory-lock identities, adapted from Qelay's `advisoryLocks.ts`, `queueLifecycle.ts`,
 * `groups.ts` and `batchAdmission.ts`. See docs/PORTING.md.
 *
 * Every lock of one kind is taken in one statement, in the order of its hash, so two transactions
 * that want overlapping sets cannot deadlock. Across kinds the order is fixed: queue lifecycle,
 * then group capacity, then admission keys.
 */

/** An unambiguous, domain-separated lock name: each component carries its length. */
export function advisoryLockName(domain: string, ...components: string[]): string {
  const base = `qcloud:${domain}`;
  if (components.length === 0) return base;
  return `${base}:${components.map((component) => `${[...component].length}:${component}`).join('')}`;
}

/**
 * Admission keys serialize racing enqueues of one custom id or one dedup key. Held to the end of
 * the transaction.
 */
export async function lockAdmissionKeys(
  tx: TransactionSQL,
  namespace: string,
  keys: readonly string[]
): Promise<void> {
  const names = [...new Set(keys)].map((key) => advisoryLockName('admission', namespace, key));
  if (names.length === 0) return;
  await tx`
    WITH ordered_keys AS MATERIALIZED (
      SELECT DISTINCT hashtextextended(lock_name, 0) AS lock_key
      FROM unnest(${tx.array(names, 'TEXT')}) AS admission(lock_name)
      ORDER BY lock_key
    ), locked_keys AS MATERIALIZED (
      SELECT lock_key, pg_advisory_xact_lock(lock_key) AS acquired
      FROM ordered_keys
      ORDER BY lock_key
    )
    SELECT COUNT(*) FROM locked_keys
  `;
}

/**
 * Admission holds each queue's lifecycle lock shared, so many enqueues run together. Deleting a
 * queue (`obliterate`, tasks 18 and 31) takes the exclusive side and waits for them.
 */
export async function lockQueuesShared(
  tx: TransactionSQL,
  namespace: string,
  queues: readonly string[]
): Promise<void> {
  const names = [...new Set(queues)].map((queue) =>
    advisoryLockName('queue-lifecycle', namespace, queue)
  );
  if (names.length === 0) return;
  await tx`
    WITH ordered_queues AS MATERIALIZED (
      SELECT DISTINCT hashtextextended(lock_name, 0) AS lock_key
      FROM unnest(${tx.array(names, 'TEXT')}) AS requested(lock_name)
      ORDER BY lock_key
    ), locked_queues AS MATERIALIZED (
      SELECT lock_key, pg_advisory_xact_lock_shared(lock_key) AS acquired
      FROM ordered_queues
      ORDER BY lock_key
    )
    SELECT COUNT(*) FROM locked_queues
  `;
}

export interface GroupRef {
  readonly queue: string;
  readonly groupId: string;
}

/** Serializes the "count pending, then insert" of a group that has a `maxSize`. */
export async function lockGroupCapacity(
  tx: TransactionSQL,
  namespace: string,
  groups: readonly GroupRef[]
): Promise<void> {
  const names = [
    ...new Set(
      groups.map(({ queue, groupId }) =>
        advisoryLockName('group-capacity', namespace, queue, groupId)
      )
    ),
  ];
  if (names.length === 0) return;
  await tx`
    WITH requested AS MATERIALIZED (
      SELECT DISTINCT hashtextextended(lock_name, 0) AS lock_key
      FROM unnest(${tx.array(names, 'TEXT')}) AS locks(lock_name)
      ORDER BY lock_key
    ), acquired AS MATERIALIZED (
      SELECT lock_key, pg_advisory_xact_lock(lock_key)
      FROM requested ORDER BY lock_key
    )
    SELECT COUNT(*) FROM acquired
  `;
}

/**
 * The exclusive side of a queue's lifecycle lock, held to the end of the transaction. Taking it waits
 * for every enqueue into the queue that is in flight and holds back new ones, which is what lets
 * `obliterate` delete a queue's rows without a job arriving in the middle of it.
 */
export async function lockQueueExclusive(
  tx: TransactionSQL,
  namespace: string,
  queue: string
): Promise<void> {
  const name = advisoryLockName('queue-lifecycle', namespace, queue);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}

/** Registers each queue once there is a job in it. Idempotent. */
export async function registerQueues(
  tx: TransactionSQL,
  namespace: string,
  queues: readonly string[]
): Promise<void> {
  const names = [...new Set(queues)].sort();
  if (names.length === 0) return;
  await tx`
    INSERT INTO qcloud_queue_state (namespace, queue)
    SELECT ${namespace}, queue
    FROM unnest(${tx.array(names, 'TEXT')}) AS admitted(queue)
    ON CONFLICT (namespace, queue) DO NOTHING
  `;
}
