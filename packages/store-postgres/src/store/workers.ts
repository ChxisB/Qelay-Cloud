import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { runTransaction } from './retry';

/**
 * The registry of live workers, for the panel's worker page and for a cron's `skipIfNoWorker`.
 * Adapted from Qelay's `workers.ts` (see docs/PORTING.md; the defaults are upstream's). Upstream tied
 * a row to one broker session; here a row is the worker's own claim to be alive, kept by its heartbeat
 * and removed by the tick when it stops. No job lease depends on it: a job is recovered by its lease.
 */

/** Heartbeat age past which a worker is not active, and past which the tick deletes it. */
export const DEFAULT_WORKER_ACTIVE_MS = 30_000;
export const DEFAULT_WORKER_EXPIRE_MS = 90_000;
export const MAX_LISTED_WORKERS = 1000;
const MAX_QUEUES_PER_WORKER = 256;

export interface WorkerRegistration {
  readonly id: string;
  /** Queues the worker pulls from. At least one. */
  readonly queues: readonly string[];
  readonly name?: string;
  /** The connection or deployment that owns the worker; lets a disconnect remove all of its workers. */
  readonly clientId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly concurrency?: number;
}

export interface WorkerStats {
  readonly activeJobs?: number;
  readonly processed?: number;
  readonly failed?: number;
}

export interface WorkerInfo {
  readonly id: string;
  readonly name: string;
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly hostname: string;
  readonly pid: number;
  readonly clientId: string | null;
  readonly registeredAt: number;
  readonly lastSeen: number;
  readonly activeJobs: number;
  readonly processed: number;
  readonly failed: number;
  /** A heartbeat within `workerActiveMs` of the listing. */
  readonly active: boolean;
}

/** What the payload column holds: everything the worker page shows that no query filters on. */
interface WorkerEnvelope {
  readonly v: 1;
  readonly name: string;
  readonly concurrency: number;
  readonly hostname: string;
  readonly pid: number;
  readonly registeredAt: number;
  readonly activeJobs: number;
  readonly processed: number;
  readonly failed: number;
}

interface WorkerRow {
  readonly id: string;
  readonly client_id: string | null;
  readonly queues: string[];
  readonly payload: Uint8Array;
  readonly last_seen: number | string | bigint;
}

function count(name: string, value: number | undefined, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new UnsupportedOptionError(name, `must be an integer of at least ${min}`);
  }
  return value;
}

function validQueues(queues: readonly string[]): string[] {
  if (!Array.isArray(queues) || queues.length === 0 || queues.length > MAX_QUEUES_PER_WORKER) {
    throw new UnsupportedOptionError(
      'queues',
      `must hold from 1 to ${MAX_QUEUES_PER_WORKER} queue names`
    );
  }
  return [...new Set(queues.map((queue) => identifier('queues[]', queue)))].sort();
}

function decode(ctx: StoreContext, row: WorkerRow, now: number): WorkerInfo {
  const envelope = ctx.codec.decode(row.payload) as WorkerEnvelope | null;
  if (envelope?.v !== 1) throw new Error(`corrupt worker payload for ${row.id}`);
  const lastSeen = Number(row.last_seen);
  return {
    id: row.id,
    name: envelope.name,
    queues: row.queues,
    concurrency: envelope.concurrency,
    hostname: envelope.hostname,
    pid: envelope.pid,
    clientId: row.client_id,
    registeredAt: envelope.registeredAt,
    lastSeen,
    activeJobs: envelope.activeJobs,
    processed: envelope.processed,
    failed: envelope.failed,
    active: lastSeen > now - ctx.workerActiveMs,
  };
}

async function writeWorker(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string,
  clientId: string | null,
  queues: readonly string[],
  envelope: WorkerEnvelope,
  now: number
): Promise<void> {
  await tx`
    INSERT INTO qcloud_workers (namespace, id, client_id, queues, payload, last_seen)
    VALUES (${ctx.namespace}, ${id}, ${clientId}, ${tx.array([...queues], 'TEXT')},
            ${ctx.codec.encode(envelope)}, ${now})
    ON CONFLICT (namespace, id) DO UPDATE SET
      client_id = excluded.client_id, queues = excluded.queues,
      payload = excluded.payload, last_seen = excluded.last_seen`;
}

async function lockWorker(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string
): Promise<WorkerRow | undefined> {
  const [row] = await tx<WorkerRow[]>`
    SELECT id, client_id, queues, payload, last_seen FROM qcloud_workers
    WHERE namespace = ${ctx.namespace} AND id = ${id}
    FOR UPDATE`;
  return row;
}

/**
 * Registers a worker, or re-registers one that is already known: its queues and identity are
 * replaced, its start time and counters kept. Call it at start and again whenever `heartbeatWorker`
 * says the row is gone (it expired while the worker was paused or partitioned).
 */
export async function registerWorker(
  ctx: StoreContext,
  registration: WorkerRegistration
): Promise<WorkerInfo> {
  const id = identifier('id', registration.id);
  const queues = validQueues(registration.queues);
  const concurrency = count('concurrency', registration.concurrency, 1, 1);
  const pid = count('pid', registration.pid, 0);
  const clientId =
    registration.clientId === undefined ? null : identifier('clientId', registration.clientId);
  return ctx.db.run('registerWorker', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const existing = await lockWorker(tx, ctx, id);
      const before = existing ? (ctx.codec.decode(existing.payload) as WorkerEnvelope) : null;
      const envelope: WorkerEnvelope = {
        v: 1,
        name: registration.name ?? before?.name ?? id,
        concurrency,
        hostname: registration.hostname ?? before?.hostname ?? 'unknown',
        pid,
        registeredAt: before?.registeredAt ?? now,
        activeJobs: before?.activeJobs ?? 0,
        processed: before?.processed ?? 0,
        failed: before?.failed ?? 0,
      };
      await writeWorker(tx, ctx, id, clientId, queues, envelope, now);
      return decode(
        ctx,
        { id, client_id: clientId, queues, payload: ctx.codec.encode(envelope), last_seen: now },
        now
      );
    })
  );
}

/**
 * Records a heartbeat and the worker's counters. False when the worker is not registered (it
 * expired): nothing changed, and the caller registers again.
 */
export async function heartbeatWorker(
  ctx: StoreContext,
  id: string,
  stats: WorkerStats = {}
): Promise<boolean> {
  const workerId = identifier('id', id);
  const activeJobs = count('activeJobs', stats.activeJobs, -1, 0);
  const processed = count('processed', stats.processed, -1, 0);
  const failed = count('failed', stats.failed, -1, 0);
  return ctx.db.run('heartbeatWorker', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const row = await lockWorker(tx, ctx, workerId);
      if (!row) return false;
      const before = ctx.codec.decode(row.payload) as WorkerEnvelope;
      const envelope: WorkerEnvelope = {
        ...before,
        activeJobs: activeJobs < 0 ? before.activeJobs : activeJobs,
        processed: processed < 0 ? before.processed : processed,
        failed: failed < 0 ? before.failed : failed,
      };
      await tx`
        UPDATE qcloud_workers SET payload = ${ctx.codec.encode(envelope)}, last_seen = ${now}
        WHERE namespace = ${ctx.namespace} AND id = ${workerId}`;
      return true;
    })
  );
}

/** Removes a worker that is stopping cleanly. False when it was not registered. */
export async function removeWorker(ctx: StoreContext, id: string): Promise<boolean> {
  const workerId = identifier('id', id);
  return ctx.db.run('removeWorker', async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM qcloud_workers WHERE namespace = ${ctx.namespace} AND id = ${workerId}
      RETURNING id`;
    return rows.length > 0;
  });
}

/** Removes every worker a client registered (it disconnected). Returns how many. */
export async function removeClientWorkers(ctx: StoreContext, clientId: string): Promise<number> {
  const owner = identifier('clientId', clientId);
  return ctx.db.run('removeClientWorkers', async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM qcloud_workers WHERE namespace = ${ctx.namespace} AND client_id = ${owner}
      RETURNING id`;
    return rows.length;
  });
}

/** Every registered worker, by id, active or not (`active` says which). At most `MAX_LISTED_WORKERS`. */
export async function listWorkers(ctx: StoreContext): Promise<WorkerInfo[]> {
  return ctx.db.run('listWorkers', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql<WorkerRow[]>`
      SELECT id, client_id, queues, payload, last_seen FROM qcloud_workers
      WHERE namespace = ${ctx.namespace}
      ORDER BY id
      LIMIT ${MAX_LISTED_WORKERS}`;
    return rows.map((row) => decode(ctx, row, now));
  });
}

/** Which of `queues` have a worker whose last heartbeat is recent. Read inside the caller's transaction. */
export async function queuesWithWorker(
  tx: TransactionSQL,
  ctx: StoreContext,
  queues: readonly string[],
  now: number
): Promise<Set<string>> {
  if (queues.length === 0) return new Set();
  const rows = await tx<Array<{ queue: string }>>`
    SELECT DISTINCT served.queue
    FROM qcloud_workers worker, unnest(worker.queues) AS served(queue)
    WHERE worker.namespace = ${ctx.namespace}
      AND worker.last_seen > ${now - ctx.workerActiveMs}
      AND served.queue = ANY(${tx.array([...queues], 'TEXT')})`;
  return new Set(rows.map((row) => row.queue));
}

export interface WorkerExpiry {
  readonly expired: number;
  /** More stale workers than the limit were found. */
  readonly more: boolean;
}

/** Deletes workers with no heartbeat for `workerExpireMs`, at most `limit` (a step of the tick). */
export async function expireWorkers(ctx: StoreContext, limit = 1000): Promise<WorkerExpiry> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('expireWorkers', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // One row past the cap tells whether another pass has work; it is locked, not deleted.
      const stale = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_workers
        WHERE namespace = ${ctx.namespace} AND last_seen <= ${now - ctx.workerExpireMs}
        ORDER BY last_seen, id
        LIMIT ${cap + 1}
        FOR UPDATE SKIP LOCKED`;
      const ids = stale.slice(0, cap).map((row) => row.id);
      if (ids.length > 0) {
        await tx`
          DELETE FROM qcloud_workers
          WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(ids, 'TEXT')})`;
      }
      return { expired: ids.length, more: stale.length > cap };
    })
  );
}
