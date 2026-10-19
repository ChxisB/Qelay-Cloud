import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Delivery } from '@qelay-cloud/core';
import { decodeBell } from './bell';
import { DeleteBatcher } from './deleteBatch';
import { isStaleHandle } from './errors';
import type { SqsMetrics } from './metrics';
import { toError } from './options';
import type { QueueUrls } from './queueUrls';

/** SQS: at most 10 messages in one receive. */
export const MAX_RECEIVE = 10;
/** SQS: a message can be invisible for at most 12 hours from its receive. */
const MAX_VISIBILITY_SECONDS = 43_200;
const MAX_BACKOFF_MS = 5_000;
/** The loop looks at the capacity again at least this often, in case a refresh was missed. */
const RECHECK_MS = 1_000;

export interface ReceiverOptions {
  readonly client: SQSClient;
  readonly urls: QueueUrls;
  readonly metrics: SqsMetrics;
  readonly namespace: string;
  readonly queue: string;
  /** The SQS queue name of the Qelay queue. */
  readonly queueName: string;
  readonly handler: (delivery: Delivery) => Promise<void>;
  /** How many deliveries the worker can take right now: asked before every receive and every dispatch. */
  readonly capacity: () => number;
  readonly waitSeconds: number;
  readonly visibilitySeconds: number;
  readonly maxNackHoldMs: number;
  readonly closeTimeoutMs: number;
  readonly backoffMs: number;
  readonly onError: (error: Error) => void;
}

interface Held {
  readonly message: Message;
  settled: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
}

/**
 * One queue's long-poll loop, driven by demand.
 *
 * - It asks for no more bells than the worker can take (`capacity()`, which is free slots and so
 *   already net of the handlers running, less the bells it holds and has not started), so a busy
 *   worker receives nothing and leaves the backlog where other workers and the stats see it.
 * - A bell that arrives with no capacity waits, hidden, in a local queue and is delivered when
 *   capacity opens. It is never nacked for being busy: a nack burns a receive, and a busy fleet
 *   would push its own bells into the dead-letter queue.
 * - The handler acks after its claim attempt (a delete by receipt handle, sent with the others of
 *   the queue in a `DeleteMessageBatch`, see `DeleteBatcher`). Until a bell is settled
 *   its visibility timeout is extended every third of it; a settled bell is never extended, because
 *   a late extension would undo the retry time a nack just set.
 * - A handler that returns or throws without settling gets its bell nacked at once.
 * - Close aborts the long poll, gives waiting bells back, and waits (bounded) for the handlers.
 */
export class QueueReceiver {
  readonly #options: ReceiverOptions;
  readonly #abort = new AbortController();
  readonly #waiting: Held[] = [];
  readonly #running = new Set<Promise<void>>();
  readonly #deletes: DeleteBatcher;
  #wake: (() => void) | null = null;
  #closing: Promise<void> | null = null;
  #loop: Promise<void> | null = null;

  constructor(options: ReceiverOptions) {
    this.#options = options;
    this.#deletes = new DeleteBatcher(options);
  }

  start(): void {
    this.#loop ??= this.#receiveLoop();
  }

  /** Bells received and waiting for capacity right now. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** Capacity changed: start waiting bells, and let the loop look at the room again. */
  refresh(): void {
    this.#pump();
    this.#wake?.();
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  get #isClosing(): boolean {
    return this.#closing !== null;
  }

  #capacity(): number {
    try {
      return Math.max(0, Math.floor(this.#options.capacity()));
    } catch (error) {
      this.#options.onError(toError(error));
      return 0;
    }
  }

  async #receiveLoop(): Promise<void> {
    const { client, urls, metrics } = this.#options;
    let backoff = this.#options.backoffMs;
    while (!this.#isClosing) {
      const room = this.#capacity() - this.#waiting.length;
      if (room <= 0) {
        await this.#idle();
        continue;
      }
      let messages: Message[];
      try {
        const url = await urls.url(this.#options.queueName);
        metrics.receiveCalls += 1;
        const out = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: Math.min(MAX_RECEIVE, room),
            WaitTimeSeconds: this.#options.waitSeconds,
            VisibilityTimeout: this.#options.visibilitySeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.#abort.signal }
        );
        messages = out.Messages ?? [];
        backoff = this.#options.backoffMs;
      } catch (error) {
        if (this.#isClosing) return;
        metrics.receiveErrors += 1;
        this.#options.onError(toError(error));
        await this.#idle(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      if (messages.length === 0) metrics.emptyReceives += 1;
      metrics.received += messages.length;
      metrics.largestReceive = Math.max(metrics.largestReceive, messages.length);
      for (const message of messages) {
        if (!message.ReceiptHandle) continue;
        const held: Held = { message, settled: false, heartbeat: null };
        if (this.#isClosing) {
          // A receive that finished as close began: give the bell back at once.
          void this.#changeVisibility(held, 0, 'nacks');
          continue;
        }
        this.#hold(held);
        this.#waiting.push(held);
      }
      this.#pump();
    }
  }

  /** Waits for a wake-up (a refresh, a finished handler, close) or for `ms`, whichever is first. */
  #idle(ms = RECHECK_MS): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  #pump(): void {
    while (!this.#isClosing && this.#waiting.length > 0) {
      // Asked again for every bell: a handler that took its slots on the way in is seen at once.
      if (this.#capacity() <= 0) return;
      const held = this.#waiting.shift();
      if (held) this.#dispatch(held);
    }
  }

  /** Extends the visibility timeout every third of its length until the bell is settled. */
  #hold(held: Held): void {
    const { visibilitySeconds } = this.#options;
    held.heartbeat = setInterval(
      () => {
        if (held.settled) return;
        void this.#changeVisibility(held, visibilitySeconds, 'heartbeats');
      },
      Math.max(250, (visibilitySeconds * 1_000) / 3)
    );
  }

  #settle(held: Held): boolean {
    if (held.settled) return false;
    held.settled = true;
    if (held.heartbeat !== null) clearInterval(held.heartbeat);
    held.heartbeat = null;
    return true;
  }

  #dispatch(held: Held): void {
    const { namespace, queue, handler } = this.#options;
    const count = Number(held.message.Attributes?.ApproximateReceiveCount);
    const delivery: Delivery = {
      bell: decodeBell(held.message.Body, { namespace, queue }),
      attempt: Number.isInteger(count) && count > 0 ? count : null,
      ack: async () => {
        if (this.#settle(held)) this.#deletes.add(held.message.ReceiptHandle!);
      },
      nack: async (retryInMs = 0) => {
        if (!this.#settle(held)) return;
        const hold = Math.min(
          Math.max(0, Math.ceil(retryInMs) || 0),
          this.#options.maxNackHoldMs,
          MAX_VISIBILITY_SECONDS * 1_000
        );
        await this.#changeVisibility(held, Math.ceil(hold / 1_000), 'nacks');
      },
    };
    const run: Promise<void> = (async () => {
      try {
        await handler(delivery);
      } catch (error) {
        this.#options.onError(toError(error));
      }
      if (!held.settled) await delivery.nack(0);
    })().finally(() => {
      this.#running.delete(run);
      this.#wake?.();
      this.#pump();
    });
    this.#running.add(run);
  }

  async #changeVisibility(
    held: Held,
    seconds: number,
    counter: 'heartbeats' | 'nacks'
  ): Promise<void> {
    const { client, urls, metrics, queueName } = this.#options;
    metrics[counter] += 1;
    try {
      const url = await urls.url(queueName);
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: held.message.ReceiptHandle,
          VisibilityTimeout: seconds,
        })
      );
    } catch (error) {
      this.#countFailure(error);
    }
  }

  /** A stale receipt handle is counted and nothing more; anything else is also reported. */
  #countFailure(error: unknown): void {
    const { metrics } = this.#options;
    if (isStaleHandle(error)) {
      metrics.staleHandles += 1;
      return;
    }
    metrics.visibilityErrors += 1;
    this.#options.onError(toError(error));
  }

  async #shutdown(): Promise<void> {
    // Aborting a long poll can strand what the server just handed out until its visibility timeout
    // ends. That is harmless for doorbells: the tick rings every claimable job again.
    this.#abort.abort();
    this.#wake?.();
    const waiting = this.#waiting.splice(0);
    await Promise.all(
      waiting.map((held) =>
        this.#settle(held) ? this.#changeVisibility(held, 0, 'nacks') : Promise.resolve()
      )
    );
    const finished = Promise.allSettled([this.#loop, ...this.#running]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#options.closeTimeoutMs);
    });
    await Promise.race([finished, timeout]);
    clearTimeout(timer);
    await this.#deletes.drain();
  }
}
