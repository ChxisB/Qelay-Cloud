import type { Codec, JobState } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { EventRecorder, StoreEvent } from './events';

/**
 * The event journal: what `PostgresStore` records by default, and how a reader follows it. Adapted
 * from Qelay's `eventJournal.ts` and `events.ts` (see docs/PORTING.md). The tables, the commit
 * sequencer and the retention counters are task 11's DDL (`schema/ddl/events.ts`) and are kept as
 * upstream built them.
 *
 * Why readers follow `commit_seq` and not the event id: ids come from a sequence when the row is
 * inserted, so a transaction that inserted early can commit after one that inserted later. A reader
 * polling `id > cursor` would pass the later id and never see the earlier row. A deferred trigger
 * gives each committing transaction a `commit_seq` under a per-namespace advisory lock, in commit
 * order, and a reader's cursor is `(commit_seq, id)`. An event of a transaction that rolled back
 * has a row in no one's snapshot, and its transaction has no commit.
 */

/** Where a reader stands: everything up to and including this event of this commit is consumed. */
export interface EventCursor {
  readonly commitSeq: number;
  readonly eventId: number;
}

/** Before every event. */
export const JOURNAL_START: EventCursor = { commitSeq: 0, eventId: 0 };

/** A cursor at the end of a commit: the commit is consumed whole, whatever ids its events have. */
const WHOLE_COMMIT = Number.MAX_SAFE_INTEGER;

export const DEFAULT_EVENT_PAGE = 1000;
export const MAX_EVENT_PAGE = 5000;

export interface JournalEvent {
  readonly commitSeq: number;
  readonly id: number;
  readonly queue: string;
  readonly type: StoreEvent['type'];
  readonly jobId: string;
  readonly occurredAt: number;
  readonly state: JobState | null;
  readonly error?: string;
  readonly removed?: true;
  readonly progress?: number;
}

export interface EventPage {
  /** In commit order. Empty when `gap` is true. */
  readonly events: readonly JournalEvent[];
  /** Pass it back to read on from here. Never behind the cursor given. */
  readonly cursor: EventCursor;
  /** More events are waiting past this page. */
  readonly more: boolean;
  /**
   * Events the reader had not read were deleted by retention (it was away longer than the window, or
   * the queue wrote more than its cap). The journal cannot say which; the reader reloads from the
   * jobs, which are the truth. `events` is empty and `cursor` is past everything that was deleted.
   */
  readonly gap: boolean;
}

interface EventPayload {
  readonly state: JobState | null;
  readonly error?: string;
  readonly removed?: true;
  readonly progress?: number;
}

interface EventRow {
  id: number | string | bigint;
  queue: string;
  event_type: string;
  job_id: string;
  occurred_at: number | string | bigint;
  payload: Uint8Array | null;
  commit_seq: number | string | bigint;
}

/**
 * The recorder a store has unless it is given another. Writes each operation's events in the
 * operation's own transaction, so an event exists exactly when the change it describes committed.
 */
export function journalRecorder(options: {
  readonly namespace: string;
  readonly codec: Codec;
}): EventRecorder {
  return {
    async record(tx, events, now) {
      if (events.length === 0) return;
      const payloads = events.map((event): EventPayload => ({
        state: event.state,
        ...(event.error !== undefined && { error: event.error }),
        ...(event.removed && { removed: true as const }),
        ...(event.progress !== undefined && { progress: event.progress }),
      }));
      // One statement, in the operation's order: the ids a sequence hands out follow `ord`.
      await tx`
        INSERT INTO qcloud_events (namespace, queue, event_type, job_id, occurred_at, payload)
        SELECT ${options.namespace}, batch.queue, batch.event_type, batch.job_id, ${now},
               decode(batch.payload_hex, 'hex')
        FROM unnest(
          ${tx.array(
            events.map((event) => event.queue),
            'TEXT'
          )},
          ${tx.array(
            events.map((event) => event.type),
            'TEXT'
          )},
          ${tx.array(
            events.map((event) => event.jobId),
            'TEXT'
          )},
          ${tx.array(
            payloads.map((payload) => Buffer.from(options.codec.encode(payload)).toString('hex')),
            'TEXT'
          )}
        ) WITH ORDINALITY AS batch(queue, event_type, job_id, payload_hex, ord)
        ORDER BY batch.ord`;
    },
  };
}

const at = (event: JournalEvent): EventCursor => ({
  commitSeq: event.commitSeq,
  eventId: event.id,
});

function numeric(value: number | string | bigint | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toEvent(ctx: StoreContext, row: EventRow): JournalEvent {
  const payload = ctx.codec.decode(row.payload ?? new Uint8Array()) as EventPayload;
  return {
    commitSeq: numeric(row.commit_seq),
    id: numeric(row.id),
    queue: row.queue,
    type: row.event_type as StoreEvent['type'],
    jobId: row.job_id,
    occurredAt: numeric(row.occurred_at),
    state: payload.state,
    ...(payload.error !== undefined && { error: payload.error }),
    ...(payload.removed && { removed: true as const }),
    ...(payload.progress !== undefined && { progress: payload.progress }),
  };
}

function checkedCursor(cursor: EventCursor): EventCursor {
  const { commitSeq, eventId } = cursor;
  if (!Number.isSafeInteger(commitSeq) || commitSeq < 0) {
    throw new UnsupportedOptionError('cursor.commitSeq', 'must be a non-negative integer');
  }
  if (!Number.isSafeInteger(eventId) || eventId < 0) {
    throw new UnsupportedOptionError('cursor.eventId', 'must be a non-negative integer');
  }
  return cursor;
}

/** The cursor at the end of the journal now: a reader that starts here sees only what comes after. */
export async function eventBaseline(ctx: StoreContext): Promise<EventCursor> {
  return ctx.db.run('eventBaseline', async (sql) => {
    const [row] = await sql<Array<{ commit_seq: number | string | bigint | null }>>`
      SELECT max(commit_seq) AS commit_seq FROM qcloud_event_commits
      WHERE namespace = ${ctx.namespace} AND commit_seq IS NOT NULL`;
    return { commitSeq: numeric(row?.commit_seq), eventId: WHOLE_COMMIT };
  });
}

/**
 * One page of events committed after `cursor`, in commit order, then event id. With a `queue`, that
 * queue's events and its retention alone count. Events are at-least-once hints that something
 * changed; the jobs are the truth, so a reader that sees `gap` reloads from them and goes on from
 * the cursor it is given.
 */
export async function readEvents(
  ctx: StoreContext,
  cursor: EventCursor,
  options: { readonly limit?: number; readonly queue?: string } = {}
): Promise<EventPage> {
  const from = checkedCursor(cursor);
  const limit = options.limit ?? DEFAULT_EVENT_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_EVENT_PAGE}`);
  }
  const queue = options.queue ?? null;
  return ctx.db.run('readEvents', async (sql) => {
    // Events first, then the watermarks: a prune that commits between the two shows in the second
    // read, so a page that is missing deleted events is never reported whole.
    const rows = await sql<EventRow[]>`
      SELECT event.id, event.queue, event.event_type, event.job_id, event.occurred_at,
             event.payload, journal.commit_seq
      FROM qcloud_event_commits AS journal
      JOIN qcloud_events AS event
        ON event.namespace = journal.namespace AND event.transaction_id = journal.transaction_id
      WHERE journal.namespace = ${ctx.namespace}
        AND journal.commit_seq IS NOT NULL
        AND journal.commit_seq >= ${from.commitSeq}
        AND (journal.commit_seq, event.id) > (${from.commitSeq}, ${from.eventId})
        AND (${queue}::text IS NULL OR event.queue = ${queue})
      ORDER BY journal.commit_seq, event.id
      LIMIT ${limit + 1}`;
    const [mark] = await sql<
      Array<{ pruned: number | string | bigint | null; through: number | string | bigint | null }>
    >`
      SELECT max(pruned_commit_seq) AS pruned, max(pruned_through) AS through
      FROM qcloud_event_prune_watermarks
      WHERE namespace = ${ctx.namespace} AND commit_seq IS NOT NULL
        AND (${queue}::text IS NULL OR queue = ${queue})`;
    const pruned = numeric(mark?.pruned);
    // Deleted events lie at or before `pruned`. A reader past that commit read them or never will
    // need them; one inside it can only tell by the event ids, which are `through` and below.
    const gap =
      pruned > from.commitSeq ||
      (pruned === from.commitSeq && numeric(mark?.through) > from.eventId);
    if (gap) {
      return {
        events: [],
        cursor: { commitSeq: pruned, eventId: WHOLE_COMMIT },
        more: true,
        gap: true,
      };
    }
    const events = rows.slice(0, limit).map((row) => toEvent(ctx, row));
    const last = events.at(-1);
    return { events, cursor: last ? at(last) : from, more: rows.length > limit, gap: false };
  });
}
