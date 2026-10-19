import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ClaimedJob, Delivery, Subscription } from '@qelay-cloud/core';
import { errorMessage } from './errorText';
import type { RunHooks } from './jobRunner';
import { JobRun } from './jobRunner';
import type { Runtime } from './runtime';
import { openRuntime } from './runtime';
import { within } from './timing';
import { emitIsolated, TypedEmitter } from './typedEmitter';
import {
  CLAIM_ERROR_RETRY_MS,
  NO_SLOT_RETRY_MS,
  returnMalformedBell,
  settleBell,
} from './workerClaim';
import { DrainWatch } from './workerDrain';
import { createRunHooks } from './workerHooks';
import type {
  Processor,
  ResolvedWorkerOptions,
  WorkerCloseOptions,
  WorkerEvents,
  WorkerOptions,
} from './workerOptions';
import { resolveWorkerOptions, runtimeOptions } from './workerOptions';
import { Pump } from './workerPump';
import { WorkerRegistry } from './workerRegistry';
import { shutdownWorker } from './workerShutdown';

/**
 * The consumer side of one queue: Qelay's `Worker` over Postgres, with a cloud queue as the
 * doorbell. It turns bells into claimed, heartbeated, completed or failed jobs.
 *
 * ```ts
 * const worker = new Worker('telemetry', async (job, { signal }) => handle(job.data, signal), {
 *   databaseUrl, transport, namespace: 'prod', concurrency: 8,
 * });
 * process.on('SIGTERM', () => void worker.close());
 * ```
 *
 * The worker keeps its own slots: `concurrency` jobs at most, however many bells the transport
 * delivers, and a busy worker asks for none. A bell is acknowledged after the claim attempt, never
 * after the job, and it is only a nudge: the claim takes whatever the queue has for the free slots.
 * A job whose lease is lost is abandoned, never completed or failed by this worker.
 */
export class Worker<T = unknown, R = unknown> extends TypedEmitter<WorkerEvents<T, R>> {
  /** The queue this worker takes jobs from. */
  readonly name: string;
  /** This worker's id in `qcloud_workers` and the owner of its leases. */
  readonly id: string;
  readonly #rt: Runtime;
  readonly #options: ResolvedWorkerOptions;
  readonly #processor: Processor<T, R>;
  readonly #registry: WorkerRegistry;
  readonly #drain: DrainWatch;
  readonly #hooks: RunHooks;
  readonly #runs = new Set<JobRun>();
  readonly #rings = new Set<Promise<void>>();
  readonly #pump: Pump;
  #subscription: Subscription | null = null;
  #paused = false;
  #closing: Promise<void> | null = null;
  #closed = false;
  #processed = 0;
  #failed = 0;

  /** Opens nothing until `run()`, which `autorun` (default) calls from here. Throws `UnsupportedOptionError` for an option this package does not support. */
  constructor(name: string, processor: Processor<T, R>, options: WorkerOptions) {
    super();
    if (typeof processor !== 'function')
      throw new TypeError('Worker: the processor must be a function');
    this.#options = resolveWorkerOptions(options);
    this.#rt = openRuntime(name, options, runtimeOptions(this.#options));
    this.name = name;
    this.#processor = processor;
    this.id = `${hostname().slice(0, 100)}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const { group } = this.#options;
    this.#pump = new Pump({
      rt: this.#rt,
      queue: name,
      owner: this.id,
      options: group === undefined ? {} : { group },
      capacity: () => this.#capacity(),
      closing: () => this.#closing !== null,
      start: (job, startedAt) => this.#start(job, startedAt),
      emitError: (error) => this.#emitError(error),
    });
    this.#registry = new WorkerRegistry(this.#rt, {
      id: this.id,
      name: this.#options.workerName,
      queue: name,
      concurrency: Math.min(this.#options.concurrency, 1_000_000),
      intervalMs: this.#options.heartbeatInterval,
      stats: () => ({
        activeJobs: this.#runs.size,
        processed: this.#processed,
        failed: this.#failed,
      }),
      onError: (error) => this.#emitError(error),
    });
    this.#hooks = createRunHooks({
      rt: this.#rt,
      emit: (event, ...args) => this.#emitSafe(event, ...args),
      emitError: (error) => this.#emitError(error),
      settled: (outcome) => {
        if (outcome === 'processed') this.#processed += 1;
        else this.#failed += 1;
      },
      track: (work) => {
        this.#rings.add(work);
        void work.finally(() => this.#rings.delete(work));
      },
    });
    this.#drain = new DrainWatch({
      afterMs: this.#options.drainedAfterMs,
      idle: () => this.#runs.size === 0 && this.#pump.reserved === 0 && this.#closing === null,
      pending: async () => {
        const counts = await this.#rt.store.counts(this.name);
        return counts.waiting + counts.prioritized;
      },
      emit: () => this.#emitSafe('drained'),
    });
    if (this.#options.autorun) this.run();
  }

  /** Starts taking jobs and registers the worker. Does nothing when it already runs or is closing. */
  run(): void {
    if (this.#subscription !== null || this.#closing !== null) return;
    this.#registry.start();
    this.#registry.ready.then(
      () => this.#emitSafe('ready'),
      () => {}
    );
    this.#subscription = this.#rt.transport.subscribe(
      this.name,
      (delivery) => this.#onBell(delivery),
      { capacity: () => this.#capacity() }
    );
  }

  /** Stops taking jobs; the ones running continue. `resume` takes jobs again. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#subscription?.refresh();
  }

  isRunning(): boolean {
    return this.#subscription !== null && !this.#paused && this.#closing === null;
  }

  isPaused(): boolean {
    return this.#paused;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  get concurrency(): number {
    return this.#options.concurrency;
  }

  /** Jobs this worker is running or finishing right now. */
  get activeJobs(): number {
    return this.#runs.size;
  }

  /** Resolves when the worker is registered, which proves the database answers and holds a migrated schema. */
  async waitUntilReady(): Promise<void> {
    if (this.#subscription === null) this.run();
    await this.#registry.ready;
  }

  /**
   * Stops taking bells, lets running jobs finish for `graceMs`, then aborts them and releases their
   * leases without counting a failure, removes the worker's registry row, and closes the store (the
   * transport too with `closeTransport`) when this worker opened it. Idempotent: later calls return
   * the first one's promise. `true` is `{ graceMs: 0 }`, the way Qelay's `close(force)` reads.
   */
  close(options?: boolean | WorkerCloseOptions): Promise<void> {
    const resolved =
      typeof options === 'object' ? options : { graceMs: options === true ? 0 : undefined };
    this.#closing ??= this.#shutdown(resolved.graceMs ?? 10_000, resolved.timeout ?? 5_000);
    return this.#closing;
  }

  /** The same as `close`, for code written against Qelay's `disconnect`. */
  disconnect(): Promise<void> {
    return this.close();
  }

  /** How many bells the transport may deliver right now: the free slots, none when paused or closing. */
  #capacity(): number {
    if (this.#paused || this.#closing !== null) return 0;
    return Math.max(0, this.#options.concurrency - this.#runs.size - this.#pump.reserved);
  }

  /**
   * One bell. Slots are taken here, before the first await, so bells that arrive while the claim is
   * out cannot take the same ones, and a transport that over-delivers is nacked, not obeyed.
   */
  async #onBell(delivery: Delivery): Promise<void> {
    // Not a bell: back to the broker, counted (see `returnMalformedBell`).
    if (delivery.bell === null) return returnMalformedBell(this.#rt, this.name, delivery);
    const want = this.#pump.want();
    if (want <= 0) {
      await this.#settle(() => delivery.nack(NO_SLOT_RETRY_MS));
      return;
    }
    const started = await this.#pump.claimAndStart(want);
    await this.#settle(() =>
      started === null ? delivery.nack(CLAIM_ERROR_RETRY_MS) : delivery.ack()
    );
    if (started === 0) this.#drain.arm();
  }

  #settle(action: () => Promise<void>): Promise<void> {
    return settleBell(this.#rt, this.name, action);
  }

  #start(claimed: ClaimedJob, startedAt: number): void {
    this.#drain.work();
    const run = new JobRun(
      {
        rt: this.#rt,
        processor: this.#processor as Processor,
        hooks: this.#hooks,
        leaseMs: this.#rt.store.leaseMs,
      },
      claimed,
      startedAt
    );
    this.#runs.add(run);
    void run.done.finally(() => {
      this.#runs.delete(run);
      this.#subscription?.refresh();
      this.#drain.arm();
      // A run that lost its lease or was released leaves a job another claim may find: not a reason to claim.
      if (run.wrote && this.#options.claimAgain) void this.#pump.pump();
    });
  }

  /** An error event nobody listens to is logged, not thrown: EventEmitter would crash the process. */
  #emitError(error: Error): void {
    if (this.listenerCount('error') > 0) this.#emitSafe('error', error);
    else this.#rt.warn('worker error', { queue: this.name, error: errorMessage(error) });
  }

  /** A listener that throws must not break the job or the loop that emitted. */
  #emitSafe(event: string, ...args: unknown[]): void {
    emitIsolated(this, event, args, (error) =>
      this.#rt.warn('worker listener threw', { event, error: errorMessage(error) })
    );
  }

  async #shutdown(graceMs: number, timeout: number): Promise<void> {
    this.#drain.cancel();
    const subscription = this.#subscription;
    this.#subscription = null;
    await shutdownWorker({
      graceMs,
      timeout,
      runs: () => this.#runs,
      rings: () => this.#rings,
      subscription,
      deregister: (ms) => this.#registry.stop(ms),
      closeOwned: async (ms) => {
        if (this.#options.closeTransport) await within(this.#rt.transport.close(), ms);
        await this.#rt.close({ timeout: ms });
      },
    });
    this.#closed = true;
    this.#emitSafe('closed');
  }
}
