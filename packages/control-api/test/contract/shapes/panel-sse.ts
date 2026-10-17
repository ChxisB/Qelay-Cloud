// Frame parsing and activity decoding of the panel's event stream, copied so a contract test runs the
// panel's own code on what `GET /events` sends (MIT, see docs/PORTING.md). Do not edit; delete with
// `panel-types.ts` when task 33 exists.
//
//   panel commit: 8ebf9328950a23a2f2687115a0ec15e66b7659bd (2026-10-09)
//   From src/lib/sse.ts: `SseFrame`, `SseConnectError`, `shouldDiscardLastEventId` (with its status set),
//   `usableEventId` and `parseFrame`.
//   From src/lib/useActivityStream.ts: `activityPayload`, `statusFromEvent` and the helpers they use. The
//   only change is `export` on the ones a test calls.
//   sha256 of the copied text below this header: 234787dc2bed82136d390d55d40679b86254016a8630cbb57a4956b7eeaffdf4
//
export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/** Connect/response failure with the HTTP status preserved for retry policy. */
export class SseConnectError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly lastEventIdSent = false
  ) {
    super(message);
    this.name = 'SseConnectError';
  }
}

const LAST_EVENT_ID_REJECTION_STATUSES = new Set([400, 409, 413, 431]);

/**
 * Whether a frame-less HTTP response plausibly rejected Last-Event-ID itself.
 * Authentication, server failures, and transport errors must retain the
 * checkpoint so a transient outage does not silently create a replay gap.
 */
export function shouldDiscardLastEventId(error: unknown): boolean {
  return (
    error instanceof SseConnectError &&
    error.lastEventIdSent &&
    LAST_EVENT_ID_REJECTION_STATUSES.has(error.status)
  );
}

/**
 * Event IDs are later copied into an HTTP header. Real server IDs are tiny
 * (usually counters/UUIDs); 4 KiB leaves ample protocol headroom while avoiding
 * an unbounded reconnect header and common proxy header-size limits.
 */
export const SSE_MAX_EVENT_ID_CHARS = 4096;

function usableEventId(value: string): boolean {
  // The event-stream spec requires an `id` field containing U+0000 to be
  // ignored. Oversized IDs are likewise ignored, but never invalidate the data
  // event that carried them.
  return !value.includes('\0') && value.length <= SSE_MAX_EVENT_ID_CHARS;
}

export function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / heartbeat
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id' && usableEventId(value)) id = value;
  }

  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    /* keep as string */
  }
  return { id, event, data };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function optionalString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length <= maxChars ? value : undefined;
}

export function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function validTimestamp(value: unknown, fallback: number): number {
  const timestamp = optionalFiniteNumber(value);
  if (timestamp !== undefined && Math.abs(timestamp) <= 8.64e15) return timestamp;
  return Number.isFinite(fallback) && Math.abs(fallback) <= 8.64e15 ? fallback : 0;
}

/** Normalize the untrusted JSON carried by a job SSE frame. */
export function activityPayload(data: unknown): {
  queue?: string;
  jobId?: string;
  name?: string;
  timestamp: number;
  error?: string;
  progress?: number;
} {
  const record = isRecord(data) ? data : {};
  const wallNow = Date.now();
  return {
    queue: optionalString(record.queue, 256),
    jobId: optionalString(record.jobId, 1024),
    name: optionalString(record.name, 512),
    timestamp: validTimestamp(record.timestamp, wallNow),
    error: optionalString(record.error, 4096),
    progress: optionalFiniteNumber(record.progress),
  };
}

export function statusFromEvent(event: string): string {
  const suffix = event.includes(':') ? event.split(':')[1] : event;
  switch (suffix) {
    case 'pushed':
    case 'added':
      return 'waiting';
    case 'pulled':
    case 'progress': // colours the row as running; not counted as a new activation
      return 'active';
    default:
      return suffix;
  }
}
