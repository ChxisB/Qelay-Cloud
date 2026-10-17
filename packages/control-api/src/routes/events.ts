import { z } from 'zod';
import { ApiError } from '../errors';
import type { EventType } from '../events/frames';
import { EVENT_TYPES, parsePosition } from '../events/frames';
import { StreamGate } from '../events/gate';
import { openEventStream } from '../events/stream';
import type { Route, RouteContext } from '../http/router';
import type { JobsContext } from '../jobs/context';

const eventsQuery = z.object({
  queue: z.string().min(1).max(256).optional(),
  types: z.string().max(512).optional(),
  cursor: z.string().max(64).optional(),
});

/** `pushed,completed` or `job:pushed,job:completed`; null (every type) when none is named. */
function parseTypes(text: string | undefined): Set<EventType> | null {
  if (text === undefined || text.trim() === '') return null;
  const wanted = new Set<EventType>();
  for (const part of text.split(',')) {
    const name = part.trim().replace(/^(job|queue):/, '');
    const known = EVENT_TYPES.find((type) => type === name);
    if (known === undefined) {
      throw ApiError.invalid('types names an event type that does not exist', {
        type: name.slice(0, 64),
        allowed: [...EVENT_TYPES],
      });
    }
    wanted.add(known);
  }
  return wanted;
}

/**
 * Live job events as server-sent events: `GET /events` for every queue, `GET /events/queues/:queue`
 * (what the panel opens) or `?queue=` for one. `?types=` keeps only some event types.
 *
 * Frames carry the journal position as their `id`. A client that reconnects sends it as
 * `Last-Event-ID` (that header wins over `?cursor=`) and continues without a gap or a repeat. A
 * position that is not one of ours is 400 and one past the journal's end is 409, which the panel
 * answers by dropping its saved id and starting live. Without a position the stream starts at the
 * journal's end: only what happens from now on.
 *
 * Bounds: a principal's open streams are capped (429), so are the instance's (503), a stream ends
 * cleanly after `maxLifetimeMs`, and a client that stops reading is dropped. See `openEventStream`.
 * The events are hints that something changed: when a client sees `resync` it reloads the lists.
 */
export function eventRoutes(ctx: JobsContext): Route[] {
  const { store, config, clock, logger } = ctx;
  const gate = new StreamGate(config.events.maxPerPrincipal, config.events.maxStreams);

  async function open(context: RouteContext, pathQueue?: string): Promise<Response> {
    const query = context.query(eventsQuery);
    if (pathQueue !== undefined && query.queue !== undefined && query.queue !== pathQueue) {
      throw ApiError.invalid('queue in the query is not the queue in the path', {
        path: pathQueue,
        query: query.queue,
      });
    }
    const queue = pathQueue ?? query.queue ?? null;
    const types = parseTypes(query.types);

    const sent = context.request.headers.get('last-event-id') ?? query.cursor;
    const requested = sent === null || sent === undefined || sent === '' ? null : sent;
    const resume = requested === null ? null : parsePosition(requested);
    if (requested !== null && resume === null) {
      throw new ApiError(
        400,
        'invalid_cursor',
        'the event position is not one this service issued'
      );
    }
    const end = await store.events.baseline();
    if (resume !== null && resume.commitSeq > end.commitSeq) {
      throw new ApiError(409, 'cursor_ahead', 'the event position is past the end of the journal', {
        hint: 'start without a position',
      });
    }

    const principal = context.principal!;
    const release = gate.acquire(`${principal.source}:${principal.subject}`);
    const signal = context.request.signal;
    if (signal.aborted) {
      release();
      return new Response(null, { status: 499 });
    }
    const body = openEventStream({
      store,
      config: config.events,
      clock,
      logger,
      from: resume ?? end,
      queue,
      types,
      signal,
      release,
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  return [
    { method: 'GET', path: '/events', access: 'read', handle: (context) => open(context) },
    {
      method: 'GET',
      path: '/events/queues/:queue',
      access: 'read',
      handle: (context) => open(context, context.params.queue!),
    },
  ];
}
