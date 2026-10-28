import type { BatchProcessor, Processor, ResolvedWorkerOptions, WorkerJob } from './workerOptions';

/** What a worker runs for each claimed job, and how many jobs it holds at once. */
export interface ProcessingPlan<T, R> {
  readonly run: Processor<T, R>;
  /** Jobs held at once: `concurrency`, or `concurrency × size` with batches. */
  readonly slots: number;
  /** A claim is made only when this many slots are free: a whole batch, so freed slots do not make one-job batches. */
  readonly floor: number;
  /** Starts the batch being filled now. Nothing to do without batches. */
  readonly flush: () => void;
}

export function planProcessing<T, R>(
  processor: Processor<T, R> | BatchProcessor<T, R>,
  { batch, concurrency }: ResolvedWorkerOptions
): ProcessingPlan<T, R> {
  if (batch === undefined) {
    return { run: processor as Processor<T, R>, slots: concurrency, floor: 1, flush: () => {} };
  }
  const collector = new BatchCollector(processor as BatchProcessor<T, R>, {
    ...batch,
    calls: concurrency,
  });
  return {
    run: collector.process,
    slots: concurrency * batch.size,
    floor: batch.size,
    flush: () => collector.flush(),
  };
}

interface Entry<T, R> {
  readonly job: WorkerJob<T>;
  readonly signal: AbortSignal;
  readonly resolve: (result: R) => void;
  readonly reject: (error: unknown) => void;
}

export interface BatchConfig {
  /** Jobs per handler call. */
  readonly size: number;
  /** How long a short batch waits, from its first job. */
  readonly maxWaitMs: number;
  /** Handler calls at once (the worker's `concurrency`); a batch that is due waits for a free call. */
  readonly calls: number;
}

/**
 * Turns a worker's runs into batches. Every claimed job keeps its own `JobRun` (lease, heartbeat, watchdog, attempts,
 * backoff) and `process` is the processor each of them calls: it holds the job until `size` jobs are there or `maxWaitMs`
 * has passed since the first, calls the handler once, and hands each job its own outcome for its run to write, so a
 * mixed result, a throw and a lost lease all go through the paths a single job takes.
 *
 * shortcut: every job beats its own lease (the store has no batched heartbeat), so a batch of 1,000 is 1,000 beats per
 * third of the lease; add a `heartbeatMany` to the store when that shows up in a profile.
 */
export class BatchCollector<T, R> {
  readonly #handler: BatchProcessor<T, R>;
  readonly #config: BatchConfig;
  #pending: Entry<T, R>[] = [];
  #due: Entry<T, R>[][] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #calls = 0;

  constructor(handler: BatchProcessor<T, R>, config: BatchConfig) {
    this.#handler = handler;
    this.#config = config;
  }

  /** The processor of every run. */
  readonly process: Processor<T, R> = (job, { signal }) =>
    new Promise<R>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = { job, signal, resolve, reject };
      this.#pending.push(entry);
      // A job aborted before its batch starts leaves it (lease lost, or the worker out of grace).
      signal.addEventListener('abort', () => this.#leave(entry), { once: true });
      if (this.#pending.length >= this.#config.size) this.#cut();
      else this.#timer ??= setTimeout(() => this.#cut(), this.#config.maxWaitMs);
    });

  /** Starts the batch being filled now, whatever its size: a closing worker must not make its jobs wait. */
  flush(): void {
    if (this.#pending.length > 0) this.#cut();
  }

  #cut(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#due.push(this.#pending);
    this.#pending = [];
    this.#next();
  }

  #next(): void {
    while (this.#calls < this.#config.calls && this.#due.length > 0)
      void this.#call(this.#due.shift()!);
  }

  #leave(entry: Entry<T, R>): void {
    const batch = [this.#pending, ...this.#due].find((jobs) => jobs.includes(entry));
    if (batch === undefined) return; // already in a call: the call watches its own signals
    batch.splice(batch.indexOf(entry), 1);
    this.#due = this.#due.filter((jobs) => jobs.length > 0);
    if (this.#pending.length === 0 && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    entry.reject(entry.signal.reason);
  }

  async #call(batch: Entry<T, R>[]): Promise<void> {
    this.#calls += 1;
    // The handler's signal aborts when no job in the batch can use its answer.
    const controller = new AbortController();
    let aborted = 0;
    for (const { signal } of batch) {
      signal.addEventListener(
        'abort',
        () => ++aborted === batch.length && controller.abort(signal.reason),
        { once: true }
      );
    }
    try {
      const out = await this.#handler(
        batch.map((entry) => entry.job),
        { signal: controller.signal }
      );
      if (out === undefined) {
        for (const entry of batch) entry.resolve(undefined as R);
      } else if (Array.isArray(out) && out.length === batch.length) {
        batch.forEach((entry, i) =>
          out[i] instanceof Error ? entry.reject(out[i]) : entry.resolve(out[i] as R)
        );
      } else {
        // Nothing says which job an entry belongs to, so no job is completed on a guess.
        const error = new Error(
          `the batch handler must return nothing or one entry per job: got ${
            Array.isArray(out) ? `${out.length} entries` : typeof out
          } for ${batch.length} jobs`
        );
        for (const entry of batch) entry.reject(error);
      }
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    } finally {
      this.#calls -= 1;
      this.#next();
    }
  }
}
