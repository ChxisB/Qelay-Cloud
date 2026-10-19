import type { JobOptions, JobRecord } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { Envelope } from './prepare';
import { identifier } from './prepare';
import { MAX_PAGE_SIZE } from './readModels';
import { JOB_COLUMNS } from './readQueries';
import type { JobRow } from './reads';
import { toRecord } from './reads';

/**
 * One job read in full, for the job's own page and for `Job` in the SDK: the record every list shows
 * plus its progress, result, failure, timestamps and the options it was enqueued with.
 */
export interface JobDetails extends JobRecord {
  /** 0 to 100. */
  readonly progress: number;
  /** The text a progress update carried with it, or null. */
  readonly progressMessage: string | null;
  /** What the handler returned. Null until the job completed, and for a handler that returned nothing. */
  readonly returnValue: unknown;
  /** The message of the last failure. Null for a job that has not failed, or that retried since. */
  readonly failedReason: string | null;
  /** When a worker first claimed the job (database clock, epoch ms), or null. */
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /**
   * The row's `version`: bumped by a claim, a heartbeat, a finish and every operator edit, so an
   * operator action that names the version it read (`expectedVersion`) cannot land on a job that moved.
   */
  readonly version: number;
  /**
   * The job's parent in a flow, or null when it has none or the parent is gone (it was removed or
   * cancelled, and the child went on as a plain job).
   */
  readonly parentId: string | null;
  /** The root of the flow the job was added in, or null for a job that is in none. */
  readonly flowRoot: string | null;
  /**
   * The options the job was enqueued with, read back from its columns and payload. `delay` is not
   * among them: it was spent at enqueue (see `runAt`). For a grouped job, `priority` is the group's.
   */
  readonly options: JobOptions;
}

type Count = number | string | bigint;

interface DetailRow extends JobRow {
  readonly progress: number | string;
  readonly progress_message: string | null;
  readonly result: Uint8Array | null;
  readonly error: string | null;
  readonly started_at: Count | null;
  readonly completed_at: Count | null;
  readonly version: Count;
  readonly lifo: boolean;
  readonly timeout: Count | null;
  readonly custom_id: string | null;
  readonly unique_key: string | null;
  readonly group_id: string | null;
  readonly live_parent_id: string | null;
  readonly flow_root: string | null;
}

/** `live_parent_id` is `parent_id` while that row exists: a stale reference is not a parent. */
const DETAIL_COLUMNS = `${JOB_COLUMNS}, progress, progress_message, result, error, started_at,
         completed_at, version, lifo, timeout, custom_id, unique_key, group_id, flow_root,
         CASE WHEN EXISTS (
           SELECT 1 FROM qcloud_jobs AS parent
           WHERE parent.namespace = qcloud_jobs.namespace AND parent.id = qcloud_jobs.parent_id
         ) THEN parent_id END AS live_parent_id`;

/** One row by primary key. Parameters: namespace, id. */
export const JOB_DETAILS = `
  SELECT ${DETAIL_COLUMNS}
  FROM qcloud_jobs WHERE namespace = $1 AND id = $2`;

/** Up to `MAX_PAGE_SIZE` rows by primary key. Parameters: namespace, a text array of ids. */
export const JOBS_DETAILS = `
  SELECT ${DETAIL_COLUMNS}
  FROM qcloud_jobs WHERE namespace = $1 AND id = ANY($2::text[])`;

const optional = (value: Count | null): number | null => (value === null ? null : Number(value));

function optionsOf(row: DetailRow, envelope: Envelope): JobOptions {
  return {
    priority: row.priority,
    lifo: row.lifo,
    attempts: row.max_attempts,
    backoff: { ...envelope.backoff },
    ...(row.timeout !== null && { timeout: Number(row.timeout) }),
    ...(envelope.stallTimeout !== undefined && { stallTimeout: envelope.stallTimeout }),
    ...(row.custom_id !== null && { jobId: row.custom_id }),
    ...(row.unique_key !== null && { deduplication: { id: row.unique_key, ...envelope.dedup } }),
    ...(row.group_id !== null && {
      group: {
        id: row.group_id,
        ...(envelope.groupMaxSize !== undefined && { maxSize: envelope.groupMaxSize }),
      },
    }),
    ...(envelope.removeOnComplete !== undefined && { removeOnComplete: envelope.removeOnComplete }),
    ...(envelope.removeOnFail !== undefined && { removeOnFail: envelope.removeOnFail }),
  };
}

function toDetails(ctx: StoreContext, row: DetailRow, now: number): JobDetails {
  const envelope = ctx.codec.decode(row.payload) as Envelope;
  return {
    ...toRecord(ctx, row, now),
    progress: Number(row.progress),
    progressMessage: row.progress_message,
    returnValue: row.result === null ? null : ctx.codec.decode(row.result),
    failedReason: row.error,
    startedAt: optional(row.started_at),
    completedAt: optional(row.completed_at),
    version: Number(row.version),
    parentId: row.live_parent_id,
    flowRoot: row.flow_root,
    options: optionsOf(row, envelope),
  };
}

export async function jobDetails(ctx: StoreContext, id: string): Promise<JobDetails | null> {
  return ctx.db.run('jobDetails', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql.unsafe<DetailRow[]>(JOB_DETAILS, [ctx.namespace, id]);
    return row ? toDetails(ctx, row, now) : null;
  });
}

/**
 * Several jobs in full, in the order of `ids`, one query. An unknown id is left out. At most
 * `MAX_PAGE_SIZE` ids, so a page of a list can be read in full without a query per job.
 */
export async function jobsDetails(
  ctx: StoreContext,
  ids: readonly string[]
): Promise<JobDetails[]> {
  if (ids.length === 0) return [];
  if (ids.length > MAX_PAGE_SIZE) {
    throw new UnsupportedOptionError('ids', `must be at most ${MAX_PAGE_SIZE} jobs`);
  }
  return ctx.db.run('jobsDetails', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql.unsafe<DetailRow[]>(JOBS_DETAILS, [
      ctx.namespace,
      sql.array(
        ids.map((id) => identifier('ids[]', id)),
        'TEXT'
      ),
    ]);
    const byId = new Map(rows.map((row) => [row.id, toDetails(ctx, row, now)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  });
}
