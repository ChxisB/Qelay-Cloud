import type { Clock } from '@qelay-cloud/core';
import type { EventCursor, PostgresStore } from '@qelay-cloud/store-postgres';
import type { Logger } from '../http/log';
import type { EventStreamConfig } from '../jobs/limits';
import type { EventType } from './frames';
import { commentFrame, eventFrame, handshakeFrame, resyncFrame } from './frames';

export interface EventStreamInput {
  readonly store: Pick<PostgresStore, 'events'>;
  readonly config: EventStreamConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Where to continue from: the client's `Last-Event-ID`, or the journal's end. */
  readonly from: EventCursor;
  readonly queue: string | null;
  /** Null: every type. */
  readonly types: ReadonlySet<EventType> | null;
  /** The request's own: aborted when the client goes away. */
  readonly signal: AbortSignal;
  /** Gives the connection's place back. Called once, on every way the stream can end. */
  readonly release: () => void;
}

/** What a client that reconnects after a clean close waits, in ms (`retry:` of the handshake). */
const RECONNECT_MS = 2_000;

/**
 * The body of `GET /events`: the journal from `from`, as server-sent events.
 *
 * It is pull-driven. The store is read only when the client has room (the stream's queue is under
 * `bufferBytes`), so a slow client slows its own stream and does not grow memory: the queue is at
 * most `bufferBytes` plus the one page that was being written. A client that leaves the queue full
 * for `slowClientMs` is disconnected, and it resumes from its last `id` when it comes back.
 *
 * The stream ends cleanly after `maxLifetimeMs` (so a client re-authenticates, and a balancer's
 * request timeout never cuts it mid-frame) and when the store fails (the client reconnects and gets
 * the real error as a response). Neither loses anything: the next connection continues from the
 * last event the client received.
 *
 * The transport has no wake-up for a journal commit, so an idle stream polls every `pollMs`. All
 * decisions about time use the injected clock; only the wait between polls is a timer.
 */
export function openEventStream(input: EventStreamInput): ReadableStream<Uint8Array> {
  const { store, config, clock, logger } = input;
  const startedAt = clock.now();
  let cursor = input.from;
  let lastWrite = startedAt;
  let finished = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | null = null;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(slowTimer);
    wake?.();
    input.signal.removeEventListener('abort', finish);
    input.release();
  };
  input.signal.addEventListener('abort', finish, { once: true });

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array
  ): void => {
    controller.enqueue(chunk);
    lastWrite = clock.now();
    if (controller.desiredSize !== null && controller.desiredSize <= 0 && slowTimer === undefined) {
      slowTimer = setTimeout(() => {
        if (finished) return;
        finish();
        logger.warn('event stream dropped: the client is not reading', {
          slowClientMs: config.slowClientMs,
        });
        try {
          controller.error(new Error('the client is not reading'));
        } catch {
          // Already closed or cancelled: nothing is left to tell.
        }
      }, config.slowClientMs);
    }
  };

  const end = (controller: ReadableStreamDefaultController<Uint8Array>, note: string): void => {
    finish();
    try {
      controller.enqueue(commentFrame(note));
      controller.close();
    } catch {
      // Cancelled meanwhile.
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(handshakeFrame(cursor, RECONNECT_MS));
      },
      async pull(controller) {
        clearTimeout(slowTimer);
        slowTimer = undefined;
        // A pull has to put something in the queue before it returns, or the reader waits for ever.
        while (!finished) {
          if (clock.now() - startedAt >= config.maxLifetimeMs) {
            return end(controller, 'maximum lifetime reached: reconnect with Last-Event-ID');
          }
          let page;
          try {
            page = await store.events.read(cursor, {
              limit: config.pageSize,
              ...(input.queue === null ? {} : { queue: input.queue }),
            });
          } catch {
            logger.warn('event stream ended: the journal could not be read');
            return end(controller, 'the event journal is unavailable: reconnect');
          }
          if (finished) return;
          cursor = page.cursor;
          if (page.gap) return write(controller, resyncFrame(cursor));
          const wanted =
            input.types === null
              ? page.events
              : page.events.filter((event) => input.types!.has(event.type));
          if (wanted.length > 0) {
            for (const event of wanted) write(controller, eventFrame(event));
            return;
          }
          // A page of events the client does not want: look further at once, without waiting.
          if (page.more) continue;
          if (clock.now() - lastWrite >= config.heartbeatMs) {
            return write(controller, commentFrame('keep-alive'));
          }
          await sleep(config.pollMs);
        }
      },
      cancel() {
        finish();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: config.bufferBytes })
  );
}
