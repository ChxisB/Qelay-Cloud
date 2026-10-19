import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { DEFAULT_RE_RING_AFTER_MS, DEFAULT_RING_GRACE_MS } from './ringQuery';

/**
 * What the Control API's Transport and Deployment pages read from the database beyond the job
 * tables: whether the doorbell path is keeping up with the claimable jobs, the schema version the
 * database records, and how many connections it is serving. Every read is bounded and takes no lock.
 */

/** Counts of one queue stop here: "1,000 or more" is as informative as the exact number. */
export const DEFAULT_HEALTH_COUNT_CAP = 1_000;
/** The most ids `existing` is asked about in one call. */
export const MAX_EXISTING_IDS = 1_000;

export interface DoorbellHealth {
  readonly queue: string;
  /** Jobs a worker could claim now: pending with `run_at` passed. Counted up to the cap. */
  readonly claimable: number;
  /**
   * Claimable jobs with no bell on record (`rung_at` null), past the grace that protects a fresh
   * enqueue. A job here is waiting for the tick: a large or growing count means the tick is behind.
   */
  readonly notRung: number;
  /**
   * Claimable jobs whose last bell is older than the re-ring threshold. The tick rings them again.
   * While a queue has more jobs than workers this is large and normal: bells are fungible, and an
   * old bell may still be waiting at the broker.
   */
  readonly reRingDue: number;
  /** Time since the oldest not-rung job became claimable, null when none is. */
  readonly oldestNotRungAgeMs: number | null;
  /** The queue is paused, so the tick does not ring it. Its claimable jobs are held on purpose. */
  readonly paused: boolean;
  /** At least one count stopped at the cap. */
  readonly capped: boolean;
}

export interface DoorbellHealthOptions {
  /** Default the tick's own grace (2,000 ms). */
  readonly graceMs?: number;
  /** Default the tick's re-ring threshold (5,000 ms). */
  readonly reRingAfterMs?: number;
  /** Default 1,000. */
  readonly countCap?: number;
}

export interface ConnectionUsage {
  /** Server connections to this database, whoever opened them. */
  readonly inUse: number;
  /** The database's `max_connections`. */
  readonly maxConnections: number;
}

export interface DeploymentApi {
  /**
   * Per queue: claimable jobs against the jobs that have no bell (see `DoorbellHealth`), on the
   * database's clock. Each queue is three bounded index scans, so give it the queues that have
   * pending jobs, not every queue.
   */
  doorbellHealth(
    queues: readonly string[],
    options?: DoorbellHealthOptions
  ): Promise<DoorbellHealth[]>;
  /** The highest migration the database records: 0 before the first has run, null when the table is empty. */
  schemaVersion(): Promise<number | null>;
  /** Connections in use and the cap. */
  connections(): Promise<ConnectionUsage>;
  /** Which of `ids` are jobs of this namespace (a primary-key lookup). */
  existing(ids: readonly string[]): Promise<Set<string>>;
}

const PENDING = `('waiting', 'prioritized', 'delayed')`;

/**
 * One row for one queue. Parameters: namespace, queue, now, graceMs, reRingAfterMs, cap. The
 * three counts are `LIMIT`ed subselects, so a backlog of millions costs the cap and not the
 * backlog; the oldest not-rung job is a `min(run_at)` over the partial index of unrung jobs. The
 * text is exported so the plan test runs the same string.
 */
export const DOORBELL_HEALTH = `
  SELECT
    (SELECT count(*) FROM (
       SELECT 1 FROM qcloud_jobs job
       WHERE job.namespace = $1 AND job.queue = $2 AND job.state IN ${PENDING} AND job.run_at <= $3
       LIMIT $6) claimable)::int AS claimable,
    (SELECT count(*) FROM (
       SELECT 1 FROM qcloud_jobs job
       WHERE job.namespace = $1 AND job.queue = $2 AND job.rung_at IS NULL AND job.state IN ${PENDING}
         AND job.run_at <= $3 AND job.created_at <= $3 - $4::bigint
       LIMIT $6) unrung)::int AS not_rung,
    (SELECT count(*) FROM (
       SELECT 1 FROM qcloud_jobs job
       WHERE job.namespace = $1 AND job.queue = $2 AND job.state IN ${PENDING}
         AND job.rung_at <= $3 - $5::bigint AND job.run_at <= $3
       LIMIT $6) stale)::int AS re_ring_due,
    (SELECT min(job.run_at) FROM qcloud_jobs job
       WHERE job.namespace = $1 AND job.queue = $2 AND job.rung_at IS NULL AND job.state IN ${PENDING}
         AND job.run_at <= $3 AND job.created_at <= $3 - $4::bigint) AS oldest_not_rung,
    EXISTS (SELECT 1 FROM qcloud_queue_state state
            WHERE state.namespace = $1 AND state.queue = $2 AND state.paused) AS paused`;

interface HealthRow {
  readonly claimable: number;
  readonly not_rung: number;
  readonly re_ring_due: number;
  readonly oldest_not_rung: number | string | bigint | null;
  readonly paused: boolean;
}

function nonNegative(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new UnsupportedOptionError(name, 'must be a non-negative number of milliseconds');
  }
  return Math.floor(value);
}

async function doorbellHealth(
  ctx: StoreContext,
  queues: readonly string[],
  options: DoorbellHealthOptions = {}
): Promise<DoorbellHealth[]> {
  const graceMs = nonNegative('graceMs', options.graceMs, DEFAULT_RING_GRACE_MS);
  const reRingAfterMs = nonNegative(
    'reRingAfterMs',
    options.reRingAfterMs,
    DEFAULT_RE_RING_AFTER_MS
  );
  const cap = options.countCap ?? DEFAULT_HEALTH_COUNT_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new UnsupportedOptionError('countCap', 'must be a positive integer');
  }
  if (queues.length === 0) return [];
  return ctx.db.run('doorbellHealth', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows: DoorbellHealth[] = [];
    // One queue at a time on this connection: a page of queues is a handful of statements, and a
    // caller that wants them in parallel can split the list.
    for (const queue of queues) {
      const [row] = await sql.unsafe<HealthRow[]>(DOORBELL_HEALTH, [
        ctx.namespace,
        queue,
        now,
        graceMs,
        reRingAfterMs,
        cap,
      ]);
      if (row === undefined) continue;
      rows.push({
        queue,
        claimable: row.claimable,
        notRung: row.not_rung,
        reRingDue: row.re_ring_due,
        oldestNotRungAgeMs:
          row.oldest_not_rung === null ? null : Math.max(0, now - Number(row.oldest_not_rung)),
        paused: row.paused,
        capped: row.claimable >= cap || row.not_rung >= cap || row.re_ring_due >= cap,
      });
    }
    return rows;
  });
}

async function schemaVersion(ctx: StoreContext): Promise<number | null> {
  return ctx.db.run('schemaVersion', async (sql) => {
    // A database nothing has migrated has no table to read: that is version 0, not a failure.
    const [present] = await sql<Array<{ present: boolean }>>`
      SELECT to_regclass('qcloud_schema_migrations') IS NOT NULL AS present`;
    if (present?.present !== true) return 0;
    const [row] = await sql<Array<{ version: number | string | null }>>`
      SELECT max(version) AS version FROM qcloud_schema_migrations`;
    return row?.version === null || row?.version === undefined ? null : Number(row.version);
  });
}

async function connections(ctx: StoreContext): Promise<ConnectionUsage> {
  return ctx.db.run('connectionUsage', async (sql) => {
    const [row] = await sql<Array<{ in_use: number | string; max: number | string }>>`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS in_use,
             current_setting('max_connections')::int AS max`;
    return { inUse: Number(row!.in_use), maxConnections: Number(row!.max) };
  });
}

async function existing(ctx: StoreContext, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (ids.length > MAX_EXISTING_IDS) {
    throw new UnsupportedOptionError('ids', `at most ${MAX_EXISTING_IDS} ids per call`);
  }
  return ctx.db.run('existingJobs', async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM qcloud_jobs
      WHERE namespace = ${ctx.namespace} AND id = ANY(${sql.array([...new Set(ids.map((id) => identifier('ids[]', id)))], 'TEXT')})`;
    return new Set(rows.map((row) => row.id));
  });
}

export const deploymentApi = (ctx: StoreContext): DeploymentApi => ({
  doorbellHealth: (queues, options) => doorbellHealth(ctx, queues, options),
  schemaVersion: () => schemaVersion(ctx),
  connections: () => connections(ctx),
  existing: (ids) => existing(ctx, ids),
});
