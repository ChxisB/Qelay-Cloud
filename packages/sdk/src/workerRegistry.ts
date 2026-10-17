import { hostname } from 'node:os';
import type { WorkerStats } from '@qelay-cloud/store-postgres';
import { asError } from './errorText';
import type { Runtime } from './runtime';
import { within } from './timing';

export interface RegistryOptions {
  readonly id: string;
  readonly name: string | undefined;
  readonly queue: string;
  readonly concurrency: number;
  /** Milliseconds between heartbeats; 0 registers once and never beats. */
  readonly intervalMs: number;
  readonly stats: () => WorkerStats;
  /** Called with what the registry could not do. It retries on its own at the next beat. */
  readonly onError: (error: Error) => void;
}

/**
 * The worker's row in `qcloud_workers`: registered when the worker starts, beaten at an interval
 * with its counters, registered again if the row expired (a pause longer than the expiry), and
 * removed on close. The row is information for the panel and for the tick's re-ring decision; a
 * failure here never touches a job.
 */
export class WorkerRegistry {
  #timer: ReturnType<typeof setInterval> | null = null;
  #registered = false;
  #stopped = false;
  #beating = false;
  /** Settles when the first registration did: rejects with its cause if the database is not ready. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly rt: Runtime,
    private readonly options: RegistryOptions
  ) {}

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.ready = this.#register();
    // The first failure is reported by `onError`; `ready` carries it to `waitUntilReady` as well.
    this.ready.catch((error: unknown) => this.#report(error));
    if (this.options.intervalMs > 0) {
      this.#timer = setInterval(() => void this.#beat(), this.options.intervalMs);
    }
  }

  /** Stops the heartbeat and deletes the row, waiting at most `timeoutMs`. */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await within(this.rt.store.workers.remove(this.options.id), timeoutMs);
  }

  async #register(): Promise<void> {
    const { id, name, queue, concurrency } = this.options;
    await this.rt.store.workers.register({
      id,
      queues: [queue],
      ...(name === undefined ? {} : { name }),
      hostname: hostname(),
      pid: process.pid,
      concurrency,
    });
    this.#registered = true;
  }

  #report(error: unknown): void {
    this.rt.count('qcloud.worker.registry_failed');
    if (!this.#stopped) this.options.onError(asError(error));
  }

  async #beat(): Promise<void> {
    if (this.#beating || this.#stopped) return;
    this.#beating = true;
    try {
      if (
        this.#registered &&
        (await this.rt.store.workers.heartbeat(this.options.id, this.options.stats()))
      ) {
        return;
      }
      this.#registered = false;
      await this.#register();
    } catch (error) {
      this.#registered = false;
      this.#report(error);
    } finally {
      this.#beating = false;
    }
  }
}
