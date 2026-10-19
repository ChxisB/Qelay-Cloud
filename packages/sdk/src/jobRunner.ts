import type { ClaimedJob, FailureInfo, Outcome } from '@qelay-cloud/core';
import { LeaseLostError, OutcomeUnknownError } from '@qelay-cloud/core';
import { asError, errorMessage } from './errorText';
import type { TraceHandle } from './options';
import { ringAfterCommit } from './ring';
import type { Runtime } from './runtime';
import { createWorkerJob } from './workerJob';
import type { Processor, WorkerJob } from './workerOptions';
import { UnrecoverableError } from './workerOptions';

/** What a running job reports to its worker. The worker turns each into an event. */
export interface RunHooks {
  active(job: WorkerJob): void;
  completed(job: WorkerJob, result: unknown): void;
  failed(job: WorkerJob, error: Error): void;
  progress(job: WorkerJob, progress: number | object | string): void;
  log(job: WorkerJob, message: string): void;
  stalled(jobId: string, reason: 'lease-lost' | 'lease-unconfirmed'): void;
  error(error: Error, context: string): void;
  /** A ring after a settle, so the worker can wait for it on close. */
  rung(work: Promise<void>): void;
}

export interface RunConfig {
  readonly rt: Runtime;
  readonly processor: Processor;
  readonly hooks: RunHooks;
  /** The store's lease length: what each heartbeat extends the lease by. */
  readonly leaseMs: number;
}

type State = 'running' | 'writing' | 'lost' | 'releasing' | 'ended';

function failureOf(thrown: unknown, discarded: boolean): { error: Error; info: FailureInfo } {
  const error = asError(thrown);
  return {
    error,
    info: {
      message: error.message === '' ? error.name : error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      unrecoverable: thrown instanceof UnrecoverableError || discarded,
    },
  };
}

/**
 * One claimed job from the claim to its last write. It heartbeats at a third of the lease on a real
 * timer, and a watchdog treats a lease it could not confirm in time as lost: from the start of the
 * last beat that came back true (or of the claim) plus the lease length, which is never later than
 * the database's own expiry, so a worker never writes after a lease may have been recovered and
 * handed to someone else. The writes are fenced by the lease token anyway; this keeps the worker
 * from trying and from reporting a result it cannot stand behind.
 *
 * Exactly one party writes for the job: the handler's return (`writing`), `forceRelease`
 * (`releasing`), and nobody once the lease is `lost`.
 */
export class JobRun {
  readonly id: string;
  /** Settles when the processor has returned and every write that followed is over. */
  readonly done: Promise<void>;
  #state: State = 'running';
  #closing = false;
  readonly #controller = new AbortController();
  #job: (WorkerJob & { discarded: boolean }) | null = null;
  #beatTimer: ReturnType<typeof setInterval> | null = null;
  #watchdog: ReturnType<typeof setTimeout> | null = null;
  #confirmedAt: number;
  #beating = false;
  #release: Promise<boolean> | null = null;

  /** `claimStartedAt` is `performance.now()` taken before the claim call: the lease cannot end before it plus the lease length. */
  constructor(
    private readonly config: RunConfig,
    private readonly claimed: ClaimedJob,
    claimStartedAt: number
  ) {
    this.id = claimed.id;
    this.#confirmedAt = claimStartedAt;
    this.done = this.#run();
  }

  get live(): boolean {
    return this.#state === 'running' || this.#state === 'writing';
  }

  /** True once its outcome was written: false for a lost lease, a release or a write that did not land. */
  get wrote(): boolean {
    return this.#state === 'ended';
  }

  /** Tells a processor that the worker is closing. Its job is released, not failed, if it throws. */
  abortForShutdown(): void {
    if (this.#state !== 'running') return;
    this.#closing = true;
    this.#controller.abort(new Error('worker is closing'));
  }

  /** Releases the lease now, whether or not the processor has returned. Resolves once the write is over. */
  async forceRelease(): Promise<void> {
    if (this.#state !== 'running') return;
    this.#state = 'releasing';
    this.#stopTimers();
    this.#closing = true;
    this.#controller.abort(new Error('worker is closing'));
    this.#release = this.#settle('release', () => this.config.rt.store.release(this.claimed.lease));
    await this.#release;
  }

  async #run(): Promise<void> {
    const { hooks } = this.config;
    this.#startTimers();
    const job = createWorkerJob(this.config.rt, this.claimed, {
      live: () => this.#state === 'running',
      signal: this.#controller.signal,
      progressed: (progress) => this.#job && hooks.progress(this.#job, progress),
      logged: (message) => this.#job && hooks.log(this.#job, message),
    });
    this.#job = job;
    hooks.active(job);
    const wrote = await this.config.rt.consume(
      {
        operation: 'process',
        queue: this.claimed.queue,
        jobId: this.id,
        jobName: this.claimed.name,
        attempt: this.claimed.attempts,
      },
      this.claimed.trace,
      (handle) => this.#process(job, handle)
    );
    if (wrote) this.#state = 'ended';
  }

  /** The processor and the write that follows it, so a trace covers both. False when the outcome was dropped. */
  async #process(job: WorkerJob & { discarded: boolean }, handle: TraceHandle): Promise<boolean> {
    const { hooks, processor } = this.config;
    let result: unknown;
    let thrown: unknown;
    let failed = false;
    try {
      result = await processor(job, { signal: this.#controller.signal });
    } catch (error) {
      failed = true;
      thrown = error;
    }
    this.#stopTimers();
    if (this.#state !== 'running') {
      // Lost or released while the processor ran: its outcome is dropped, never written.
      handle.event('abandoned');
      await this.#release;
      return false;
    }
    this.#state = 'writing';
    if (failed && this.#closing) {
      handle.event('released');
      await this.#settle('release', () => this.config.rt.store.release(this.claimed.lease));
    } else if (failed) {
      const { error, info } = failureOf(thrown, job.discarded);
      handle.fail(error);
      const settled = await this.#settle('fail', () =>
        this.config.rt.store.fail(this.claimed.lease, info)
      );
      if (settled) hooks.failed(job, error);
    } else if (
      await this.#settle('complete', () => this.config.rt.complete(this.claimed.lease, result))
    ) {
      handle.event('completed');
      hooks.completed(job, result);
    }
    return true;
  }

  /**
   * Writes once and, if the call throws (a deadline, a dropped connection: the outcome is unknown),
   * once more. The second answer settles it only when it is `ok`, because a refused second write
   * cannot tell a first one that landed from a lease that was lost. Returns true when the write is
   * known to have landed; otherwise reports why on the hooks.
   */
  async #settle(
    operation: 'complete' | 'fail' | 'release',
    write: () => Promise<Outcome>
  ): Promise<boolean> {
    const { hooks, rt } = this.config;
    let cause: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const started = performance.now();
        const outcome = await write();
        if (operation === 'complete')
          rt.observe('qcloud.worker.complete_ms', performance.now() - started);
        if (outcome.ok) {
          hooks.rung(ringAfterCommit(rt, outcome.rings));
          return true;
        }
        if (attempt === 0) return this.#lostOnWrite(operation);
        break;
      } catch (error) {
        cause = error;
        rt.warn(`${operation} of a job failed`, {
          jobId: this.id,
          attempt,
          error: errorMessage(error),
        });
        rt.count('qcloud.worker.settle_failed', 1, { operation });
      }
    }
    hooks.error(new OutcomeUnknownError(this.id, operation, cause), operation);
    return false;
  }

  /** The store refused the write: the token no longer holds the job. Nothing changed. */
  #lostOnWrite(operation: string): false {
    this.config.rt.count('qcloud.worker.lease_lost', 1, { at: operation });
    this.config.hooks.stalled(this.id, 'lease-lost');
    return false;
  }

  #startTimers(): void {
    const { leaseMs } = this.config;
    this.#beatTimer = setInterval(() => void this.#beat(), Math.max(1, Math.floor(leaseMs / 3)));
    this.#armWatchdog();
  }

  #stopTimers(): void {
    if (this.#beatTimer !== null) clearInterval(this.#beatTimer);
    if (this.#watchdog !== null) clearTimeout(this.#watchdog);
    this.#beatTimer = null;
    this.#watchdog = null;
  }

  #armWatchdog(): void {
    if (this.#watchdog !== null) clearTimeout(this.#watchdog);
    const left = this.#confirmedAt + this.config.leaseMs - performance.now();
    this.#watchdog = setTimeout(() => this.#lose('lease-unconfirmed'), Math.max(0, left));
  }

  /** No overlapping beats. A beat that throws proves nothing: the watchdog decides. */
  async #beat(): Promise<void> {
    if (this.#beating || this.#state !== 'running') return;
    this.#beating = true;
    const started = performance.now();
    const { rt } = this.config;
    try {
      const held = await rt.store.heartbeat(this.claimed.lease);
      if (this.#state !== 'running') return;
      if (held) {
        this.#confirmedAt = started;
        this.#armWatchdog();
      } else {
        this.#lose('lease-lost');
      }
    } catch (error) {
      rt.warn('heartbeat not confirmed', { jobId: this.id, error: errorMessage(error) });
      rt.count('qcloud.worker.heartbeat_failed');
    } finally {
      this.#beating = false;
    }
  }

  #lose(reason: 'lease-lost' | 'lease-unconfirmed'): void {
    if (this.#state !== 'running') return;
    this.#state = 'lost';
    this.#stopTimers();
    const error = new LeaseLostError(this.id);
    this.#controller.abort(error);
    this.config.rt.count('qcloud.worker.lease_lost', 1, { at: reason });
    this.config.hooks.stalled(this.id, reason);
    this.config.hooks.error(error, 'heartbeat');
  }
}
