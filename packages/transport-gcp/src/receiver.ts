import type { Message, Subscription as PubSubSubscription } from '@google-cloud/pubsub';
import type { Delivery } from '@qelay-cloud/core';
import { decodeBell } from './bell';
import { toError } from './options';

export interface ReceiverOptions {
  readonly subscription: PubSubSubscription;
  readonly namespace: string;
  readonly queue: string;
  readonly handler: (delivery: Delivery) => Promise<void>;
  /** How many deliveries the worker can take right now: asked on every message, handler end and `refresh`. */
  readonly capacity: () => number;
  readonly maxNackHoldMs: number;
  readonly onError: (error: Error) => void;
  /** First wait before a stream that died with a fatal error is opened again; doubles up to `maxRestartMs`. */
  readonly restartMs?: number;
  readonly maxRestartMs?: number;
}

interface Hold {
  readonly message: Message;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * One queue's streaming pull. The client library's flow control bounds how many bells this process
 * holds (it is static, so it is set when the subscription is built); this class decides which of
 * them start, by asking `capacity()`.
 *
 * - A bell that arrives with no capacity waits, un-acked, in a local FIFO. The client keeps
 *   extending its deadline, and the bell is delivered when capacity opens. It is never nacked for
 *   being busy: a nack burns a delivery attempt, and a busy fleet would dead-letter its own bells.
 * - The handler acks after its claim attempt. A handler that returns, or throws, without settling
 *   gets its bell nacked: otherwise the client would keep the lease for the extension limit.
 * - `nack(retryInMs)` keeps the bell, leased, for that long (at most `maxNackHoldMs`) and then
 *   returns it. A bell that is held is not redelivered, so it burns no attempt while it waits.
 * - A stream that ended with a fatal error (a missing subscription, a permission) is opened again
 *   with a growing wait, so an infrastructure fix needs no restart.
 */
export class QueueReceiver {
  readonly #options: ReceiverOptions;
  readonly #waiting: Message[] = [];
  readonly #running = new Set<Promise<void>>();
  readonly #holds = new Set<Hold>();
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #restartMs: number;
  #closing: Promise<void> | null = null;

  constructor(options: ReceiverOptions) {
    this.#options = options;
    this.#restartMs = options.restartMs ?? 1_000;
  }

  /** Bells waiting for capacity right now. */
  get waiting(): number {
    return this.#waiting.length;
  }

  start(): void {
    const { subscription } = this.#options;
    subscription.on('message', (message: Message) => this.#receive(message));
    subscription.on('error', (error: Error) => {
      this.#options.onError(toError(error));
      this.#scheduleReopen();
    });
  }

  /** Capacity changed: start as many waiting bells as it allows. */
  pump(): void {
    if (this.#closing) return;
    let room = this.#room();
    while (room > 0) {
      const message = this.#waiting.shift();
      if (!message) return;
      this.#dispatch(message);
      room -= 1;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  #room(): number {
    try {
      return Math.max(0, Math.floor(this.#options.capacity()));
    } catch (error) {
      this.#options.onError(toError(error));
      return 0;
    }
  }

  #receive(message: Message): void {
    this.#restartMs = this.#options.restartMs ?? 1_000;
    if (this.#closing) {
      message.nack();
      return;
    }
    this.#waiting.push(message);
    this.pump();
  }

  #dispatch(message: Message): void {
    const { namespace, queue, handler } = this.#options;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };
    const delivery: Delivery = {
      bell: decodeBell(message.data, { namespace, queue }),
      attempt: message.deliveryAttempt > 0 ? message.deliveryAttempt : null,
      ack: async () => {
        if (settle()) message.ack();
      },
      nack: async (retryInMs = 0) => {
        if (settle()) this.#giveBack(message, retryInMs);
      },
    };
    const run: Promise<void> = (async () => {
      try {
        await handler(delivery);
      } catch (error) {
        this.#options.onError(toError(error));
      }
      if (settle()) message.nack();
    })().finally(() => {
      this.#running.delete(run);
      this.pump();
    });
    this.#running.add(run);
  }

  #giveBack(message: Message, retryInMs: number): void {
    const wait = Math.min(Math.max(0, Math.ceil(retryInMs) || 0), this.#options.maxNackHoldMs);
    if (wait === 0) {
      message.nack();
      return;
    }
    const hold: Hold = { message, timer: setTimeout(() => this.#release(hold), wait) };
    this.#holds.add(hold);
  }

  #release(hold: Hold): void {
    clearTimeout(hold.timer);
    if (this.#holds.delete(hold)) hold.message.nack();
  }

  #scheduleReopen(): void {
    if (this.#closing || this.#restartTimer) return;
    const wait = this.#restartMs;
    this.#restartMs = Math.min(wait * 2, this.#options.maxRestartMs ?? 30_000);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      const { subscription } = this.#options;
      if (this.#closing || subscription.isOpen) return;
      try {
        subscription.open();
      } catch (error) {
        this.#options.onError(toError(error));
        this.#scheduleReopen();
      }
    }, wait);
  }

  async #shutdown(): Promise<void> {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    for (const message of this.#waiting.splice(0)) message.nack();
    for (const hold of [...this.#holds]) this.#release(hold);
    // The subscription was built to wait for the bells being handled, so their acks still go out.
    try {
      await Promise.all([
        this.#options.subscription.close(),
        Promise.allSettled([...this.#running]),
      ]);
    } catch (error) {
      this.#options.onError(toError(error));
    }
  }
}
