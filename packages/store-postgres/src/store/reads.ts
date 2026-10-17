import type { JobQuery, JobRecord, JobState, Page, StateCounts } from '@qelay-cloud/core';
import { JOB_STATES } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { Envelope } from './prepare';
import { COUNTS_BY_STATE, JOB_COLUMNS, LIST_JOBS } from './readQueries';
import { effectiveState } from './state';

/** A `(state, total)` row of a counts query. */
export interface StateTotal {
  readonly state: JobState | null;
  readonly total: number | string | bigint;
}

/** The counts of every state, 0 for the ones the rows do not mention. */
export function stateCounts(rows: readonly StateTotal[]): StateCounts {
  const totals = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<
    JobState,
    number
  >;
  for (const row of rows) if (row.state !== null) totals[row.state] = Number(row.total);
  return totals;
}

export interface JobRow {
  readonly id: string;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly state: string;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly run_at: number | string | bigint;
  readonly created_at: number | string | bigint;
  readonly lease_owner: string | null;
  readonly lease_until: number | string | bigint | null;
}

export function toRecord(ctx: StoreContext, row: JobRow, now: number): JobRecord {
  const envelope = ctx.codec.decode(row.payload) as Envelope;
  const state = effectiveState(row.state, Number(row.run_at), row.priority, now);
  return {
    id: row.id,
    queue: row.queue,
    name: envelope.name,
    data: envelope.data,
    state,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: Number(row.run_at),
    createdAt: Number(row.created_at),
    lease:
      state === 'active' && row.lease_owner !== null && row.lease_until !== null
        ? { owner: row.lease_owner, until: Number(row.lease_until) }
        : null,
  };
}

export async function getJob(ctx: StoreContext, id: string): Promise<JobRecord | null> {
  return ctx.db.run('getJob', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql<JobRow[]>`
      SELECT ${sql.unsafe(JOB_COLUMNS)} FROM qcloud_jobs
      WHERE namespace = ${ctx.namespace} AND id = ${id}`;
    return rows[0] ? toRecord(ctx, rows[0], now) : null;
  });
}

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');
const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

export async function listJobs(ctx: StoreContext, query: JobQuery): Promise<Page<JobRecord>> {
  const limit = Math.max(1, Math.floor(query.limit));
  return ctx.db.run('listJobs', async (sql) => {
    const now = await ctx.db.time.now(sql);
    // The states go in as one array literal; only names of real states are put in it, so nothing
    // in it can end the literal. An unknown name matches no job, as it did before.
    const states = query.states
      ? `{${query.states.filter((state) => JOB_STATES.includes(state)).join(',')}}`
      : null;
    const cursor = query.cursor === undefined ? '' : decodeCursor(query.cursor);
    const rows = await sql.unsafe<JobRow[]>(LIST_JOBS, [
      ctx.namespace,
      query.queue,
      cursor,
      states,
      now,
      limit + 1,
    ]);
    const items = rows.slice(0, limit).map((row) => toRecord(ctx, row, now));
    return { items, next: rows.length > limit ? encodeCursor(items.at(-1)!.id) : null };
  });
}

export async function counts(ctx: StoreContext, queue: string): Promise<StateCounts> {
  return ctx.db.run('counts', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql.unsafe<StateTotal[]>(COUNTS_BY_STATE, [ctx.namespace, queue, now]);
    return stateCounts(rows);
  });
}
