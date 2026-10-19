import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import type { AttemptRecord, DlqBlob, FailureReason } from './retryState';
import { decodeRetryState, MAX_ATTEMPT_RECORDS } from './retryState';

/**
 * What a job's page shows about how it failed: the final reason and stack of a failed job, and the
 * history of the attempts that failed before it. It lives in two blobs (`dlq_entry` of a failed job,
 * `dlq_retry_state` of one that is retrying), which the lists never read: one call here is one
 * primary-key lookup and is only for a job's own page.
 */
export interface JobFailure {
  /** Why the job ended in `failed`. Null while it is still retrying. */
  readonly reason: FailureReason | null;
  /** The stack of the failure that ended the job, when the handler sent one. */
  readonly stack: string | null;
  /** The failed attempts, oldest first, the newest `MAX_ATTEMPT_RECORDS` at most. */
  readonly attempts: readonly AttemptRecord[];
  /** How many of those attempts were a lease that ran out before the processing deadline. */
  readonly stalls: number;
}

/** One row by primary key. Parameters: namespace, id. */
export const JOB_FAILURE = `
  SELECT dlq_entry, dlq_retry_state FROM qcloud_jobs WHERE namespace = $1 AND id = $2`;

/** Up to `MAX_FAILURE_BATCH` rows by primary key. Parameters: namespace, a text array of ids. */
export const JOBS_FAILURE = `
  SELECT id, dlq_entry, dlq_retry_state FROM qcloud_jobs
  WHERE namespace = $1 AND id = ANY($2::text[])`;

interface FailureRow {
  readonly id?: string;
  readonly dlq_entry: Uint8Array | null;
  readonly dlq_retry_state: Uint8Array | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toFailure(ctx: StoreContext, row: FailureRow): JobFailure | null {
  if (row.dlq_entry !== null) {
    const blob = ctx.codec.decode(row.dlq_entry);
    if (!isRecord(blob)) return null;
    const entry = blob as unknown as DlqBlob;
    const attempts = Array.isArray(entry.attempts)
      ? entry.attempts.filter(isRecord).slice(-MAX_ATTEMPT_RECORDS)
      : [];
    return {
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      stack: typeof entry.stack === 'string' ? entry.stack : null,
      attempts: attempts as unknown as AttemptRecord[],
      stalls: attempts.filter((attempt) => attempt.reason === 'stalled').length,
    };
  }
  const state = decodeRetryState(ctx.codec, row.dlq_retry_state);
  if (state.attempts.length === 0 && state.stalls === 0) return null;
  return { reason: null, stack: null, attempts: state.attempts, stalls: state.stalls };
}

/** The failure of one job, or null when it has none (or does not exist). */
export async function jobFailure(ctx: StoreContext, id: string): Promise<JobFailure | null> {
  return ctx.db.run('jobFailure', async (sql) => {
    const [row] = await sql.unsafe<FailureRow[]>(JOB_FAILURE, [ctx.namespace, id]);
    return row ? toFailure(ctx, row) : null;
  });
}

/** Most ids of one `jobFailures` call: a page of the largest size. */
export const MAX_FAILURE_BATCH = 1_000;

/**
 * The failures of up to `MAX_FAILURE_BATCH` jobs in one query, by id. A job with no failure, or that
 * does not exist, has no key in the map.
 */
export async function jobFailures(
  ctx: StoreContext,
  ids: readonly string[]
): Promise<Map<string, JobFailure>> {
  if (ids.length === 0) return new Map();
  if (ids.length > MAX_FAILURE_BATCH) {
    throw new UnsupportedOptionError('ids', `at most ${MAX_FAILURE_BATCH} jobs per call`);
  }
  return ctx.db.run('jobFailures', async (sql) => {
    const rows = await sql.unsafe<FailureRow[]>(JOBS_FAILURE, [
      ctx.namespace,
      sql.array(
        ids.map((id) => identifier('ids[]', id)),
        'TEXT'
      ),
    ]);
    const found = new Map<string, JobFailure>();
    for (const row of rows) {
      const failure = toFailure(ctx, row);
      if (failure !== null && row.id !== undefined) found.set(row.id, failure);
    }
    return found;
  });
}
