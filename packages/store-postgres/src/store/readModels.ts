import type { JobRecord, JobState, StateCounts } from '@qelay-cloud/core';
import { JOB_STATES, UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import {
  countInState,
  DASHBOARD_COUNTS,
  JOB_BY_ID,
  jobsInState,
  PRIORITY_COUNTS,
  QUEUE_SUMMARIES,
  QUEUE_TOTALS,
} from './readQueries';
import type { JobRow, StateTotal } from './reads';
import { stateCounts, toRecord } from './reads';

/**
 * What the panel and the Control API read: queue summaries, the dashboard totals, a queue's jobs in
 * a state, and a job by custom id. Adapted from Qelay's `readModels.ts` (see docs/PORTING.md).
 * Upstream built a snapshot of every queue's jobs in memory; here each read is one bounded query,
 * and the SQL is in `readQueries.ts` so the plan test checks the text that runs.
 */

/** Most queues one `queueSummaries` page, and most jobs one `jobsInState` page. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 50;
/** `offset` is bounded so a page costs a bounded index scan; deeper reading uses `listJobs`' cursor. */
export const MAX_PAGE_OFFSET = 100_000;

type Count = number | string | bigint;

export interface QueueSummary {
  readonly queue: string;
  readonly paused: boolean;
  readonly counts: StateCounts;
}

export interface QueueSummaryPage {
  readonly items: readonly QueueSummary[];
  /** Pass as `after` for the next page, or null at the end. */
  readonly next: string | null;
}

export interface DashboardTotals {
  readonly queues: number;
  readonly pausedQueues: number;
  /** Jobs of every queue by state, summed. */
  readonly counts: StateCounts;
}

export interface JobStatePage {
  readonly items: readonly JobRecord[];
  /** Jobs in the state in the whole queue, not in the page. */
  readonly total: number;
}

function pageSize(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new UnsupportedOptionError(name, `must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value;
}

/**
 * The queues of the namespace by name, each with its counts. A queue appears once something was
 * enqueued to it or configured on it.
 */
export async function queueSummaries(
  ctx: StoreContext,
  page: { readonly limit?: number; readonly after?: string } = {}
): Promise<QueueSummaryPage> {
  const limit = pageSize('limit', page.limit, DEFAULT_PAGE_SIZE);
  const after = page.after === undefined ? '' : identifier('after', page.after);
  return ctx.db.run('queueSummaries', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql.unsafe<Array<StateTotal & { queue: string; paused: boolean }>>(
      QUEUE_SUMMARIES,
      [ctx.namespace, after, limit + 1, now]
    );
    const byQueue = new Map<string, { paused: boolean; rows: StateTotal[] }>();
    for (const row of rows) {
      const entry = byQueue.get(row.queue) ?? { paused: row.paused, rows: [] };
      entry.rows.push(row);
      byQueue.set(row.queue, entry);
    }
    const queues = [...byQueue.keys()];
    const shown = queues.slice(0, limit);
    return {
      items: shown.map((queue) => ({
        queue,
        paused: byQueue.get(queue)!.paused,
        counts: stateCounts(byQueue.get(queue)!.rows),
      })),
      next: queues.length > limit ? shown.at(-1)! : null,
    };
  });
}

/**
 * How many jobs a worker could claim now sit at each priority, as `{ "0": n, "5": m }`. A queue with
 * nothing claimable gives `{}`. One index-only scan of the queue's pending jobs, like `counts`.
 */
export async function priorityCounts(
  ctx: StoreContext,
  queueName: string
): Promise<Readonly<Record<string, number>>> {
  const queue = identifier('queue', queueName);
  return ctx.db.run('priorityCounts', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql.unsafe<Array<{ priority: number; total: Count }>>(PRIORITY_COUNTS, [
      ctx.namespace,
      queue,
      now,
    ]);
    return Object.fromEntries(rows.map((row) => [String(row.priority), Number(row.total)]));
  });
}

/** The totals of the dashboard: how many queues, how many are paused, and every state's job count. */
export async function dashboardTotals(ctx: StoreContext): Promise<DashboardTotals> {
  return ctx.db.run('dashboardTotals', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [rows, [totals]] = await Promise.all([
      sql.unsafe<StateTotal[]>(DASHBOARD_COUNTS, [ctx.namespace, now]),
      sql.unsafe<Array<{ queues: Count; paused: Count }>>(QUEUE_TOTALS, [ctx.namespace]),
    ]);
    return {
      queues: Number(totals!.queues),
      pausedQueues: Number(totals!.paused),
      counts: stateCounts(rows),
    };
  });
}

/**
 * One page of a queue's jobs in a state, with how many there are. The claimable states come in
 * claim order, delayed jobs by when they are due, the others newest first. Offset paging: a deep
 * page costs the offset in index entries (bounded by `MAX_PAGE_OFFSET`), and a job that changes
 * state while a reader pages can be skipped or seen twice. `listJobs` is the cursor read.
 */
export async function jobsByState(
  ctx: StoreContext,
  queueName: string,
  state: JobState,
  page: { readonly limit?: number; readonly offset?: number } = {}
): Promise<JobStatePage> {
  const queue = identifier('queue', queueName);
  if (!JOB_STATES.includes(state)) throw new UnsupportedOptionError('state', 'is not a job state');
  const limit = pageSize('limit', page.limit, DEFAULT_PAGE_SIZE);
  const offset = page.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
    throw new UnsupportedOptionError('offset', `must be an integer from 0 to ${MAX_PAGE_OFFSET}`);
  }
  return ctx.db.run('jobsByState', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const list = jobsInState(state, ctx.namespace, queue, now, limit, offset);
    const count = countInState(state, ctx.namespace, queue, now);
    const [rows, [total]] = await Promise.all([
      sql.unsafe<JobRow[]>(list.text, [...list.params]),
      sql.unsafe<Array<{ total: Count }>>(count.text, [...count.params]),
    ]);
    return {
      items: rows.map((row) => toRecord(ctx, row, now)),
      total: Number(total!.total),
    };
  });
}

/**
 * The job a custom id names in a queue, or null. A job's id is its custom id when the enqueue gave
 * one, so this is a primary-key lookup, and an id that belongs to a job of another queue finds none.
 */
export async function jobByCustomId(
  ctx: StoreContext,
  queueName: string,
  customId: string
): Promise<JobRecord | null> {
  const queue = identifier('queue', queueName);
  const id = identifier('customId', customId);
  return ctx.db.run('jobByCustomId', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql.unsafe<JobRow[]>(JOB_BY_ID, [ctx.namespace, id, queue]);
    return row ? toRecord(ctx, row, now) : null;
  });
}
