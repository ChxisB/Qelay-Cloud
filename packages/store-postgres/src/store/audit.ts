import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';

/**
 * The operator audit log: one row per mutation of the Control API, kept in `qcloud_audit` (migration
 * 5). A row says who (the token's subject, its role and where the token came from), what (the route
 * and the identifiers of its path, never a body or a payload), when and how it ended. The shape is a
 * fixed set of short strings on purpose: the table cannot carry job data, and every string is cut
 * to a bound, so a hostile name cannot fail or grow a row.
 *
 * Two phases. `begin` writes the row as `pending` before the operation runs, so an operation the
 * log cannot record does not run, and a process that dies in the middle leaves its intent behind;
 * `finish` closes it. `record` writes a row that never ran (refused for its role, rate limited) in
 * one statement. Rows are append-only: nothing edits one except `finish`, and only while it is
 * `pending`. Retention is by age and by count, applied by the append that crosses the interval.
 */

export type AuditOutcome = 'pending' | 'success' | 'rejected' | 'failed';

/** What an operation is, known before it runs. */
export interface AuditIntent {
  /** The token's subject. */
  readonly subject: string;
  readonly role: string;
  /** Where the token came from (`oidc`, `dev-token`). */
  readonly source: string;
  readonly requestId: string;
  /** The route, for example `POST /queues/:queue/pause`. */
  readonly action: string;
  /** The identifiers it acted on, for example `queue=emails`. Never a payload. */
  readonly target: string;
}

/** How an operation ended. */
export interface AuditResult {
  readonly outcome: Exclude<AuditOutcome, 'pending'>;
  /** HTTP status of the answer. */
  readonly status: number;
  /** A short code for a refusal or a failure (`forbidden`, `job_not_found`). */
  readonly reason?: string;
  /** Replaces the intent's target when the operation learned more (a name that came in its body). */
  readonly target?: string;
}

export interface AuditEntry extends AuditIntent {
  readonly id: number;
  readonly occurredAt: number;
  /** Null while `pending`. */
  readonly finishedAt: number | null;
  readonly outcome: AuditOutcome;
  readonly status: number | null;
  readonly reason: string | null;
}

export interface AuditQuery {
  readonly limit?: number;
  /** The previous page's `next`: entries older than this id. */
  readonly before?: number;
  readonly subject?: string;
  readonly action?: string;
  readonly outcome?: AuditOutcome;
}

export interface AuditPage {
  /** Newest first. */
  readonly items: readonly AuditEntry[];
  /** Pass it back as `before`; null when there is no older entry. */
  readonly next: number | null;
}

export const DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_AUDIT_ENTRIES = 100_000;
export const DEFAULT_AUDIT_PAGE = 50;
export const MAX_AUDIT_PAGE = 500;
/** Rows one prune deletes at most, by age and again by count. */
export const AUDIT_PRUNE_BATCH = 1_000;
/** How often an append runs the prune, at most, per store. */
export const AUDIT_PRUNE_INTERVAL_MS = 60_000;

/** Longest stored value of each column, in characters. A longer one is cut, never refused. */
const BOUNDS = {
  subject: 256,
  role: 32,
  source: 32,
  requestId: 64,
  action: 160,
  target: 512,
  reason: 128,
};

/** One row. Parameters: namespace, now, subject, role, source, request id, action, target. */
export const AUDIT_BEGIN = `
  INSERT INTO qcloud_audit (namespace, occurred_at, subject, role, source, request_id, action, target, outcome)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
  RETURNING id`;

/** A row that never ran. Parameters: namespace, now, subject, role, source, request id, action, target, outcome, status, reason. */
export const AUDIT_RECORD = `
  INSERT INTO qcloud_audit (namespace, occurred_at, finished_at, subject, role, source, request_id,
                            action, target, outcome, status, reason)
  VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING id`;

/** Closes a pending row. Parameters: namespace, id, now, outcome, status, reason, target (or null to keep it). */
export const AUDIT_FINISH = `
  UPDATE qcloud_audit
  SET finished_at = $3, outcome = $4, status = $5, reason = $6, target = COALESCE($7, target)
  WHERE namespace = $1 AND id = $2 AND outcome = 'pending'`;

/** Newest first, from `before`, with optional filters. Parameters: namespace, before, subject, action, outcome, limit. */
export const AUDIT_LIST = `
  SELECT id, occurred_at, finished_at, subject, role, source, request_id, action, target, outcome,
         status, reason
  FROM qcloud_audit
  WHERE namespace = $1
    AND ($2::bigint IS NULL OR id < $2::bigint)
    AND ($3::text IS NULL OR subject = $3::text)
    AND ($4::text IS NULL OR action = $4::text)
    AND ($5::text IS NULL OR outcome = $5::text)
  ORDER BY id DESC
  LIMIT $6`;

/** The oldest rows older than the cut. Parameters: namespace, cut, limit. */
export const AUDIT_PRUNE_AGE = `
  DELETE FROM qcloud_audit
  WHERE namespace = $1 AND id IN (
    SELECT id FROM qcloud_audit WHERE namespace = $1 AND occurred_at < $2
    ORDER BY occurred_at LIMIT $3)
  RETURNING id`;

/** The oldest rows past the newest `keep`. Parameters: namespace, keep, limit. */
export const AUDIT_PRUNE_COUNT = `
  DELETE FROM qcloud_audit
  WHERE namespace = $1 AND id IN (
    SELECT id FROM qcloud_audit
    WHERE namespace = $1 AND id <= (
      SELECT id FROM qcloud_audit WHERE namespace = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)
    ORDER BY id LIMIT $3)
  RETURNING id`;

interface AuditRow {
  readonly id: number | string | bigint;
  readonly occurred_at: number | string | bigint;
  readonly finished_at: number | string | bigint | null;
  readonly subject: string;
  readonly role: string;
  readonly source: string;
  readonly request_id: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: AuditOutcome;
  readonly status: number | null;
  readonly reason: string | null;
}

/** Cuts to `max` characters and drops NUL, which a text column refuses. */
function bounded(value: string, max: number): string {
  const clean = value.includes('\0') ? value.replaceAll('\0', '') : value;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function intentValues(intent: AuditIntent): [string, string, string, string, string, string] {
  return [
    bounded(intent.subject, BOUNDS.subject),
    bounded(intent.role, BOUNDS.role),
    bounded(intent.source, BOUNDS.source),
    bounded(intent.requestId, BOUNDS.requestId),
    bounded(intent.action, BOUNDS.action),
    bounded(intent.target, BOUNDS.target),
  ];
}

/** The row written and the store's time of it, which the facet's prune throttle reads. */
export interface Appended {
  readonly id: number;
  readonly now: number;
}

/** Writes the intent as `pending`. The caller runs the operation only if this resolves. */
export async function beginAudit(ctx: StoreContext, intent: AuditIntent): Promise<Appended> {
  return ctx.db.run('beginAudit', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql.unsafe<Array<{ id: number | string | bigint }>>(AUDIT_BEGIN, [
      ctx.namespace,
      now,
      ...intentValues(intent),
    ]);
    return { id: Number(row!.id), now };
  });
}

/** Closes a pending row. False when it is gone (pruned) or was already closed. */
export async function finishAudit(
  ctx: StoreContext,
  id: number,
  result: AuditResult
): Promise<boolean> {
  return ctx.db.run('finishAudit', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql.unsafe<unknown[]>(`${AUDIT_FINISH} RETURNING id`, [
      ctx.namespace,
      id,
      now,
      result.outcome,
      result.status,
      result.reason === undefined ? null : bounded(result.reason, BOUNDS.reason),
      result.target === undefined ? null : bounded(result.target, BOUNDS.target),
    ]);
    return rows.length === 1;
  });
}

/** Writes a row for an operation that never ran, already closed. */
export async function recordAudit(
  ctx: StoreContext,
  intent: AuditIntent,
  result: AuditResult
): Promise<Appended> {
  return ctx.db.run('recordAudit', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql.unsafe<Array<{ id: number | string | bigint }>>(AUDIT_RECORD, [
      ctx.namespace,
      now,
      ...intentValues(intent),
      result.outcome,
      result.status,
      result.reason === undefined ? null : bounded(result.reason, BOUNDS.reason),
    ]);
    return { id: Number(row!.id), now };
  });
}

const OUTCOMES: readonly string[] = ['pending', 'success', 'rejected', 'failed'];

export async function listAudit(ctx: StoreContext, query: AuditQuery = {}): Promise<AuditPage> {
  const limit = query.limit ?? DEFAULT_AUDIT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_AUDIT_PAGE}`);
  }
  if (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) {
    throw new UnsupportedOptionError('before', 'must be a positive integer');
  }
  if (query.outcome !== undefined && !OUTCOMES.includes(query.outcome)) {
    throw new UnsupportedOptionError('outcome', 'must be pending, success, rejected or failed');
  }
  return ctx.db.run('listAudit', async (sql) => {
    const rows = await sql.unsafe<AuditRow[]>(AUDIT_LIST, [
      ctx.namespace,
      query.before ?? null,
      query.subject ?? null,
      query.action ?? null,
      query.outcome ?? null,
      limit + 1,
    ]);
    const page = rows.slice(0, limit).map((row): AuditEntry => ({
      id: Number(row.id),
      occurredAt: Number(row.occurred_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      subject: row.subject,
      role: row.role,
      source: row.source,
      requestId: row.request_id,
      action: row.action,
      target: row.target,
      outcome: row.outcome,
      status: row.status,
      reason: row.reason,
    }));
    return {
      items: page,
      next: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}

/** Deletes rows past the age and the count cap, a bounded batch of each. Returns how many. */
export async function pruneAudit(ctx: StoreContext, limit = AUDIT_PRUNE_BATCH): Promise<number> {
  return ctx.db.run('pruneAudit', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const old = await sql.unsafe<unknown[]>(AUDIT_PRUNE_AGE, [
      ctx.namespace,
      now - ctx.auditRetentionMs,
      limit,
    ]);
    const over = await sql.unsafe<unknown[]>(AUDIT_PRUNE_COUNT, [
      ctx.namespace,
      ctx.maxAuditEntries,
      limit,
    ]);
    return old.length + over.length;
  });
}
