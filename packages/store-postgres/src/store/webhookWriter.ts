import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { Queryable } from '../time';
import type { StoreContext } from './context';
import type { EventCursor } from './journal';
import { MAX_EVENT_PAGE, readEventsOn, WHOLE_COMMIT } from './journal';
import { isRetryableTransactionError, runTransaction } from './retry';
import { dedupe } from './webhookDedupe';
import type { HookRow, Planned } from './webhookPlan';
import { hookOf, plan } from './webhookPlan';
import type { WriteOptions, WriterState, WriteResult } from './webhookTypes';

/**
 * The delivery writer (migration 14): one pass reads the journal after its cursor, makes the
 * deliveries for every enabled webhook each event matches, and moves the cursor, all in one
 * transaction, so a crash repeats the pass and nothing else. A namespace with a row in
 * `qcloud_webhook_writers` has this instead of the trigger; `schema/ddl/webhookWriter.ts` says how
 * switching on and off stays lossless.
 *
 * It makes what the trigger makes (the same rules, and the same `created_at`, so the unique index on
 * the event still guards it) plus each webhook's `filter`, `dedupe`, `shape` and `delayMs` (the delivery
 * is made at once and is due that much later). A shaped body is rendered
 * here, once, and stored: every attempt sends those bytes. A body too large to make is recorded as a
 * failed delivery with an empty `body`, which the sender refuses, so it is visible and not lost.
 *
 * One writer works at a time (the cursor row is locked `NO KEY UPDATE SKIP LOCKED`): a second one
 * gets `active: false` and tries again later.
 */

export const DEFAULT_WRITE_PAGE = 500;
/** Delivery rows per insert statement (a page of events times the webhooks they match can be large). */
const INSERT_CHUNK = 2_000;
const STOP_ATTEMPTS = 30;
const STOP_LOCK_TIMEOUT_MS = 2_000;

type Time = number | string | bigint;

interface WriterRow {
  readonly commit_seq: Time;
  readonly event_id: Time;
}

const IDLE: WriteResult = { active: false, events: 0, written: 0, more: false, gap: false };

const refusal = (): UnsupportedOptionError =>
  new UnsupportedOptionError(
    'writer',
    'webhooks with a filter, shape, delay or dedupe need the writer on: delete them first'
  );

const cursorOf = (row: WriterRow): EventCursor => ({
  commitSeq: Number(row.commit_seq),
  eventId: Number(row.event_id),
});

export async function webhookWriterState(ctx: StoreContext): Promise<WriterState> {
  return ctx.db.run('webhookWriterState', async (sql) => {
    const [row] = await sql<Array<WriterRow & { stopping: boolean }>>`
      SELECT commit_seq, event_id, stopping FROM qcloud_webhook_writers
      WHERE namespace = ${ctx.namespace}`;
    if (!row) return { mode: 'trigger', commitSeq: null, eventId: null };
    return {
      mode: row.stopping ? 'stopping' : 'writer',
      commitSeq: Number(row.commit_seq),
      eventId: Number(row.event_id),
    };
  });
}

/**
 * Switches the namespace to the writer, from the end of the journal as it is now. Safe to repeat, and
 * it also cancels a stop that did not finish. Events from before are not delivered.
 */
export async function startWebhookWriter(ctx: StoreContext): Promise<WriterState> {
  await ctx.db.run('startWebhookWriter', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      await tx`
        INSERT INTO qcloud_webhook_writers (namespace, commit_seq, event_id, started_at, updated_at)
        SELECT ${ctx.namespace}, coalesce(max(commit_seq), 0), ${WHOLE_COMMIT}, ${now}, ${now}
        FROM qcloud_event_commits WHERE namespace = ${ctx.namespace} AND commit_seq IS NOT NULL
        ON CONFLICT (namespace) DO UPDATE SET stopping = FALSE, updated_at = EXCLUDED.updated_at`;
    })
  );
  return webhookWriterState(ctx);
}

function pageLimit(options: WriteOptions): number {
  const limit = options.limit ?? DEFAULT_WRITE_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_EVENT_PAGE}`);
  }
  return limit;
}

/** One pass: the deliveries of the next page of events. `active: false` when the namespace has no writer, or another holds it. */
export async function writeWebhookDeliveries(
  ctx: StoreContext,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const limit = pageLimit(options);
  return ctx.db.run('writeWebhookDeliveries', (sql) =>
    runTransaction(sql, async (tx) => {
      const [row] = await tx<WriterRow[]>`
        SELECT commit_seq, event_id FROM qcloud_webhook_writers
        WHERE namespace = ${ctx.namespace} FOR NO KEY UPDATE SKIP LOCKED`;
      if (!row) return IDLE;
      return (await writePage(tx, ctx, cursorOf(row), limit)).result;
    })
  );
}

async function writePage(
  tx: TransactionSQL,
  ctx: StoreContext,
  from: EventCursor,
  limit: number
): Promise<{ readonly result: WriteResult; readonly cursor: EventCursor }> {
  const now = await ctx.db.time.now(tx);
  const page = await readEventsOn(tx, ctx, from, { limit });
  let written = 0;
  if (page.events.length > 0) {
    // KEY SHARE, like the trigger's: a webhook being deleted is waited for and then skipped. A paused
    // webhook still gets its deliveries (they wait, `claimDue` serves only enabled ones).
    const rows = await tx<HookRow[]>`
      SELECT id, events, queue, filter, shape, delay_ms, dedupe, active_from, created_at
      FROM qcloud_webhooks
      WHERE namespace = ${ctx.namespace} AND (enabled OR disabled_reason IS NOT NULL)
      ORDER BY id FOR KEY SHARE`;
    const planned = await dedupe(tx, ctx, plan(page.events, rows.map(hookOf)));
    for (let at = 0; at < planned.length; at += INSERT_CHUNK) {
      written += await insert(tx, ctx, planned.slice(at, at + INSERT_CHUNK), now);
    }
  }
  await tx`
    UPDATE qcloud_webhook_writers
    SET commit_seq = ${page.cursor.commitSeq}, event_id = ${page.cursor.eventId}, updated_at = ${now}
    WHERE namespace = ${ctx.namespace}`;
  return {
    result: { active: true, events: page.events.length, written, more: page.more, gap: page.gap },
    cursor: page.cursor,
  };
}

/** Inserts in order (the ids, the tie-break of the send order, follow it); a delivery that exists is left alone. */
async function insert(
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly Planned[],
  now: number
): Promise<number> {
  const made = await tx<Array<{ id: Time }>>`
    INSERT INTO qcloud_deliveries
      (namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status,
       next_attempt_at, created_at, body, last_error, finished_at)
    SELECT ${ctx.namespace}, r.v->>'w', (r.v->>'e')::bigint, r.v->>'n', r.v->>'q', r.v->>'j',
           (r.v->>'t')::bigint, CASE WHEN r.v->>'x' IS NULL THEN 'pending' ELSE 'failed' END,
           (r.v->>'a')::bigint, (r.v->>'t')::bigint, r.v->>'b', r.v->>'x',
           CASE WHEN r.v->>'x' IS NULL THEN NULL ELSE ${now}::bigint END
    FROM jsonb_array_elements(${JSON.stringify(rows)}::text::jsonb) WITH ORDINALITY AS r(v, ord)
    ORDER BY r.ord
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return made.length;
}

async function hasFiltered(sql: Queryable, namespace: string): Promise<boolean> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM qcloud_webhooks
    WHERE namespace = ${namespace}
      AND (filter IS NOT NULL OR shape IS NOT NULL OR delay_ms IS NOT NULL OR dedupe IS NOT NULL)`;
  return row!.n > 0;
}

/**
 * Switches the namespace back to the trigger without losing an event. Refused while a webhook has a
 * filter, shape, delay or dedupe (the trigger cannot apply them). It marks the row `stopping` (the trigger delivers
 * again from then on), catches the writer up, then in one transaction locks the row `FOR UPDATE`,
 * which waits for every job transaction that skipped its deliveries for the writer to commit, drains
 * what those added, and deletes the row.
 */
export async function stopWebhookWriter(
  ctx: StoreContext,
  options: WriteOptions = {}
): Promise<WriterState> {
  const limit = pageLimit(options);
  const marked = await ctx.db.run('stopWebhookWriter', async (sql) => {
    if (await hasFiltered(sql, ctx.namespace)) throw refusal();
    const rows = await sql<Array<{ x: number }>>`
      UPDATE qcloud_webhook_writers SET stopping = TRUE
      WHERE namespace = ${ctx.namespace} RETURNING 1 AS x`;
    return rows.length > 0;
  });
  if (!marked) return webhookWriterState(ctx);
  for (let attempt = 1; ; attempt += 1) {
    while ((await writeWebhookDeliveries(ctx, { limit })).more) {
      // Catch up before the lock, so the locked pass has little to do.
    }
    try {
      const outcome = await ctx.db.run('stopWebhookWriter', (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('lock_timeout', ${String(STOP_LOCK_TIMEOUT_MS)}, true)`;
          const [row] = await tx<WriterRow[]>`
            SELECT commit_seq, event_id FROM qcloud_webhook_writers
            WHERE namespace = ${ctx.namespace} FOR UPDATE`;
          await tx`SELECT set_config('lock_timeout', '0', true)`;
          if (!row) return 'stopped';
          // A filtered webhook may have been created while the lock was awaited.
          if (await hasFiltered(tx, ctx.namespace)) return 'refused';
          let cursor = cursorOf(row);
          for (;;) {
            const page = await writePage(tx, ctx, cursor, limit);
            cursor = page.cursor;
            if (!page.result.more) break;
          }
          await tx`DELETE FROM qcloud_webhook_writers WHERE namespace = ${ctx.namespace}`;
          return 'stopped';
        })
      );
      if (outcome === 'refused') {
        await startWebhookWriter(ctx);
        throw refusal();
      }
      return webhookWriterState(ctx);
    } catch (error) {
      if (attempt >= STOP_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
    }
  }
}
