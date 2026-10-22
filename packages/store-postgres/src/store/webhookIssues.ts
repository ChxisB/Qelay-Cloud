import type { WebhookIssueStatus } from '@qelay-cloud/core';
import {
  isWebhookIssueStatus,
  UnsupportedOptionError,
  WEBHOOK_HOLD_REASON,
  WEBHOOK_ISSUE_STATUSES,
} from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import type {
  IssueCounts,
  IssuePage,
  IssueQuery,
  IssueRecord,
  IssueResult,
} from './webhookIssueTypes';

/**
 * Issues (migration 18, `schema/ddl/webhookIssues.ts`). The recording path settles them (`settleIssues`, in the
 * transaction that records the attempts), the tick prunes resolved ones, and the operator reads them and sets their status.
 */

/** An issue id from a caller, as the number it stands for; anything else is refused by name. */
function issueNumber(name: string, value: string): number {
  if (!/^[1-9]\d{0,15}$/u.test(value))
    throw new UnsupportedOptionError(name, 'must be an issue id');
  return Number(value);
}

export const DEFAULT_ISSUE_PAGE = 50;
export const MAX_ISSUE_PAGE = 200;

interface IssueRow {
  readonly id: number | string | bigint;
  readonly webhook_id: string;
  readonly status: WebhookIssueStatus;
  readonly kind: 'delivery_failed';
  readonly opened_at: number | string | bigint;
  readonly updated_at: number | string | bigint;
  readonly updated_by: string | null;
}

const COLUMNS = 'id, webhook_id, status, kind, opened_at, updated_at, updated_by';

const issueOf = (row: IssueRow): IssueRecord => ({
  id: String(row.id),
  webhookId: row.webhook_id,
  status: row.status,
  kind: row.kind,
  openedAt: Number(row.opened_at),
  updatedAt: Number(row.updated_at),
  updatedBy: row.updated_by,
});

function statusOf(value: unknown): WebhookIssueStatus {
  if (!isWebhookIssueStatus(value)) {
    throw new UnsupportedOptionError('status', `must be ${WEBHOOK_ISSUE_STATUSES.join(', ')}`);
  }
  return value;
}

/** Issues of one status, newest first. */
export async function listIssues(ctx: StoreContext, query: IssueQuery): Promise<IssuePage> {
  const status = statusOf(query.status);
  const limit = query.limit ?? DEFAULT_ISSUE_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ISSUE_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_ISSUE_PAGE}`);
  }
  const webhook = query.webhook === undefined ? null : identifier('webhook', query.webhook);
  const before = query.before === undefined ? null : issueNumber('before', query.before);
  return ctx.db.run('listWebhookIssues', async (sql) => {
    const rows = await sql.unsafe<IssueRow[]>(
      `SELECT ${COLUMNS} FROM qcloud_webhook_issues
       WHERE namespace = $1 AND status = $2
         AND ($3::text IS NULL OR webhook_id = $3::text)
         AND ($4::bigint IS NULL OR id < $4::bigint)
       ORDER BY id DESC LIMIT $5`,
      [ctx.namespace, status, webhook, before, limit + 1]
    );
    const items = rows.slice(0, limit).map(issueOf);
    return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
  });
}

/** How many issues each status has. */
export async function issueCounts(ctx: StoreContext): Promise<IssueCounts> {
  return ctx.db.run('countWebhookIssues', async (sql) => {
    const rows = await sql<Array<{ status: WebhookIssueStatus; n: number }>>`
      SELECT status, count(*)::int AS n FROM qcloud_webhook_issues
      WHERE namespace = ${ctx.namespace} GROUP BY status`;
    const counts = { open: 0, acknowledged: 0, resolved: 0, ignored: 0 };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  });
}

/**
 * Sets an issue's status, by the operator `by`. A live issue can go to any other status, resolved included; a
 * resolved one is history (`resolved`). Setting the status it already has changes nothing.
 */
export async function setIssueStatus(
  ctx: StoreContext,
  id: string,
  status: WebhookIssueStatus,
  by: string
): Promise<IssueResult> {
  const target = statusOf(status);
  const number = issueNumber('id', id);
  return ctx.db.run('setWebhookIssueStatus', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<IssueRow[]>`
      UPDATE qcloud_webhook_issues SET status = ${target}, updated_at = ${now}, updated_by = ${by}
      WHERE namespace = ${ctx.namespace} AND id = ${number} AND status <> 'resolved' AND status <> ${target}
      RETURNING id, webhook_id, status, kind, opened_at, updated_at, updated_by`;
    if (row) return { outcome: 'updated', issue: issueOf(row) } as const;
    const [current] = await sql<IssueRow[]>`
      SELECT id, webhook_id, status, kind, opened_at, updated_at, updated_by FROM qcloud_webhook_issues
      WHERE namespace = ${ctx.namespace} AND id = ${number}`;
    if (!current) return { outcome: 'not_found' } as const;
    if (current.status === 'resolved' && target !== 'resolved')
      return { outcome: 'resolved' } as const;
    return { outcome: 'updated', issue: issueOf(current) } as const;
  });
}

/**
 * The recording path's call, in its transaction: `settled` maps each webhook whose attempts ended a delivery to whether
 * the last of them delivered. A failure opens an issue unless the route has a live one or is held by an operator
 * (nothing is being sent to it, so nothing is failing); a delivery resolves the live one, whatever its status.
 */
export async function settleIssues(
  tx: TransactionSQL,
  ctx: StoreContext,
  now: number,
  settled: ReadonlyMap<string, boolean>
): Promise<void> {
  const failed = [...settled].filter(([, ok]) => !ok).map(([id]) => id);
  const delivered = [...settled].filter(([, ok]) => ok).map(([id]) => id);
  if (failed.length > 0) {
    await tx`
      INSERT INTO qcloud_webhook_issues (namespace, webhook_id, status, kind, opened_at, updated_at)
      SELECT w.namespace, w.id, 'open', 'delivery_failed', ${now}, ${now}
      FROM qcloud_webhooks w
      WHERE w.namespace = ${ctx.namespace} AND w.id = ANY(${tx.array(failed, 'TEXT')})
        AND w.disabled_reason IS DISTINCT FROM ${WEBHOOK_HOLD_REASON}
      ON CONFLICT DO NOTHING`;
  }
  if (delivered.length > 0) {
    await tx`
      UPDATE qcloud_webhook_issues SET status = 'resolved', updated_at = ${now}, updated_by = NULL
      WHERE namespace = ${ctx.namespace} AND webhook_id = ANY(${tx.array(delivered, 'TEXT')})
        AND status IN ('open', 'acknowledged', 'ignored')`;
  }
}

/** Deletes issues resolved more than `webhookKeepMs` ago, at most `limit`. Returns how many. */
export async function pruneResolvedIssues(ctx: StoreContext, limit: number): Promise<number> {
  return ctx.db.run('pruneWebhookIssues', async (sql) => {
    const before = (await ctx.db.time.now(sql)) - ctx.webhookKeepMs;
    const rows = await sql<Array<{ id: number | string }>>`
      DELETE FROM qcloud_webhook_issues
      WHERE id IN (
        SELECT id FROM qcloud_webhook_issues
        WHERE namespace = ${ctx.namespace} AND status = 'resolved' AND updated_at < ${before}
        ORDER BY updated_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.length;
  });
}
