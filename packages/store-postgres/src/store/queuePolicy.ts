import type { Codec, QueuePolicy } from '@qelay-cloud/core';
import { validateQueuePolicy } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { PayloadTooLargeError } from '../errors';
import type { StoreContext } from './context';
import type { PreparedJob } from './prepare';
import { backoffOf, identifier } from './prepare';
import { lockQueueState } from './queueState';
import { runTransaction } from './retry';
import { jsonOrNull } from './webhookRows';

/**
 * A queue's retry policy (DESIGN.md D17): the attempts, backoff and timeout a job gets when it sets none of its
 * own. It is applied at enqueue and written into the job, so claiming and failing read nothing new, and a policy
 * saved later does not touch jobs that are already there. Retry jitter is the store-wide `jitter` option, not part of it.
 */

const policyOf = (stored: unknown): QueuePolicy | null => {
  const policy = jsonOrNull<unknown>(stored);
  return policy === null ? null : validateQueuePolicy(policy);
};

/** The queue's policy, or null when it has none (a queue never used included). */
export async function getQueuePolicy(ctx: StoreContext, name: string): Promise<QueuePolicy | null> {
  const queue = identifier('queue', name);
  return ctx.db.run('getQueuePolicy', async (sql) => {
    const [row] = await sql<Array<{ policy: unknown }>>`
      SELECT policy FROM qcloud_queue_state WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
    return policyOf(row?.policy);
  });
}

/**
 * Replaces the queue's policy. `null`, and `{}`, remove it. Returns what is stored. The state row is locked, as for
 * the other settings, and created if the queue was never used.
 */
export async function setQueuePolicy(
  ctx: StoreContext,
  name: string,
  policy: QueuePolicy | null
): Promise<QueuePolicy | null> {
  const queue = identifier('queue', name);
  const valid = policy === null ? {} : validateQueuePolicy(policy);
  const stored = Object.keys(valid).length === 0 ? null : valid;
  await ctx.db.run('setQueuePolicy', (sql) =>
    runTransaction(sql, async (tx) => {
      await lockQueueState(tx, ctx.namespace, queue, true);
      await tx`
        UPDATE qcloud_queue_state SET policy = ${stored === null ? null : JSON.stringify(stored)}::text::jsonb
        WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
    })
  );
  return stored;
}

/** What enqueue learns of the queues it writes to. */
export interface RegisteredQueues {
  readonly policies: ReadonlyMap<string, QueuePolicy>;
  /** Queues whose run window is closed at `now`: their jobs are not rung, the tick rings them when it opens. */
  readonly closed: ReadonlySet<string>;
}

/**
 * Registers each queue once there is a job for it, and returns the policies of those that have one and which are outside
 * their run window. One statement: the registration is a data-modifying CTE and the read sees the rows as they were
 * before it, which is right, as a queue it just created has no policy and no window. Idempotent.
 */
export async function registerQueues(
  tx: TransactionSQL,
  namespace: string,
  queues: readonly string[],
  now: number
): Promise<RegisteredQueues> {
  const names = [...new Set(queues)].sort();
  const policies = new Map<string, QueuePolicy>();
  const closed = new Set<string>();
  if (names.length === 0) return { policies, closed };
  const rows = await tx<Array<{ queue: string; policy: unknown; closed: boolean }>>`
    WITH admitted AS (
      INSERT INTO qcloud_queue_state (namespace, queue)
      SELECT ${namespace}, queue FROM unnest(${tx.array(names, 'TEXT')}) AS admitted(queue)
      ON CONFLICT (namespace, queue) DO NOTHING
    )
    SELECT queue, policy,
           window_from IS NOT NULL AND NOT (window_from <= ${now} AND ${now} < window_until) AS closed
    FROM qcloud_queue_state
    WHERE namespace = ${namespace} AND queue = ANY(${tx.array(names, 'TEXT')})
      AND (policy IS NOT NULL OR window_from IS NOT NULL)
  `;
  for (const row of rows) {
    const policy = policyOf(row.policy);
    if (policy !== null) policies.set(row.queue, policy);
    if (row.closed) closed.add(row.queue);
  }
  return { policies, closed };
}

/** `prepared` with each queue's policy laid under the settings its jobs left out. */
export function applyPolicies(
  prepared: readonly PreparedJob[],
  policies: ReadonlyMap<string, QueuePolicy>,
  codec: Codec,
  maxPayloadBytes: number
): readonly PreparedJob[] {
  if (policies.size === 0) return prepared;
  return prepared.map((job) => {
    const policy = policies.get(job.queue);
    return policy === undefined ? job : applyPolicy(job, policy, codec, maxPayloadBytes);
  });
}

function applyPolicy(
  job: PreparedJob,
  policy: QueuePolicy,
  codec: Codec,
  maxPayloadBytes: number
): PreparedJob {
  const attempts = job.own.attempts ? undefined : policy.attempts;
  const timeout = job.own.timeout ? undefined : policy.timeout;
  const backoff = job.own.backoff ? undefined : policy.backoff;
  let payload = job.payload;
  if (backoff !== undefined) {
    // The backoff is only in the payload, so the job is encoded again; it can now be over the size limit.
    payload = codec.encode({ ...job.envelope, backoff: backoffOf(backoff) });
    if (payload.byteLength > maxPayloadBytes) {
      throw new PayloadTooLargeError(payload.byteLength, maxPayloadBytes, job.index);
    }
  }
  return {
    ...job,
    payload,
    maxAttempts: attempts ?? job.maxAttempts,
    timeout: timeout ?? job.timeout,
  };
}
