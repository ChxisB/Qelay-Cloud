import type { EventCursor, JournalEvent } from '@qelay-cloud/store-postgres';

/**
 * The wire of `GET /events`: server-sent events, one frame per journal event.
 *
 * A frame's `id` is the journal position after it, `<commitSeq>.<eventId>`. A client that sends it
 * back as `Last-Event-ID` (the browser does by itself, the panel's reader does by hand) continues
 * from the next event, without a gap and without a repeat: the position is a total order that the
 * store assigns in commit order, so two writers committing at once cannot swap it.
 */

/** The event types the journal records. Their frames are `job:<type>`, except `obliterated`. */
export const EVENT_TYPES = [
  'pushed',
  'duplicated',
  'updated',
  'promoted',
  'priority',
  'removed',
  'pulled',
  'released',
  'completed',
  'retried',
  'stalled',
  'failed',
  'progress',
  'obliterated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Longest error text a frame carries: a frame is a hint to reload, the job holds the full message. */
const MAX_ERROR_CHARS = 2_000;
const POSITION = /^(\d{1,16})\.(\d{1,16})$/;

const encoder = new TextEncoder();

export const encodePosition = (cursor: EventCursor): string =>
  `${cursor.commitSeq}.${cursor.eventId}`;

/** The cursor a `Last-Event-ID` or `cursor` names, or null when it is not one of ours. */
export function parsePosition(text: string): EventCursor | null {
  const match = POSITION.exec(text);
  if (match === null) return null;
  const commitSeq = Number(match[1]);
  const eventId = Number(match[2]);
  return Number.isSafeInteger(commitSeq) && Number.isSafeInteger(eventId)
    ? { commitSeq, eventId }
    : null;
}

const frame = (lines: readonly string[]): Uint8Array => encoder.encode(`${lines.join('\n')}\n\n`);

/** The first frame: tells the client the stream is live and the position it starts from. */
export const handshakeFrame = (cursor: EventCursor, retryMs: number): Uint8Array =>
  frame([`retry: ${retryMs}`, `id: ${encodePosition(cursor)}`, 'data: {"connected":true}']);

/** A comment: keeps the connection open through proxies and is ignored by every parser. */
export const commentFrame = (text: string): Uint8Array => frame([`: ${text}`]);

/** The journal lost events the client had not read: reload from the jobs, then go on. */
export const resyncFrame = (cursor: EventCursor): Uint8Array =>
  frame([`id: ${encodePosition(cursor)}`, 'event: resync', 'data: {"reason":"events_pruned"}']);

/** One event. `obliterated` is about the queue and not a job, so it has no job id. */
export function eventFrame(event: JournalEvent): Uint8Array {
  const at = encodePosition({ commitSeq: event.commitSeq, eventId: event.id });
  if (event.type === 'obliterated') {
    return frame([
      `id: ${at}`,
      'event: queue:obliterated',
      `data: ${JSON.stringify({ queue: event.queue, type: event.type, timestamp: event.occurredAt })}`,
    ]);
  }
  const data = {
    queue: event.queue,
    jobId: event.jobId,
    type: event.type,
    state: event.state,
    timestamp: event.occurredAt,
    ...(event.error === undefined ? {} : { error: event.error.slice(0, MAX_ERROR_CHARS) }),
    ...(event.progress === undefined ? {} : { progress: event.progress }),
    ...(event.removed === true ? { removed: true } : {}),
  };
  return frame([`id: ${at}`, `event: job:${event.type}`, `data: ${JSON.stringify(data)}`]);
}
