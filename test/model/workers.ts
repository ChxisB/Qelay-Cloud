import type {
  ClaimedJob,
  ClaimOptions,
  Lease,
  Outcome,
  RingItem,
  RingResult,
  RungEntry,
} from '@qelay-cloud/core';
import type { Processor } from '../../packages/sdk/src/index';
import { UnrecoverableError, Worker } from '../../packages/sdk/src/index';
import type { PostgresStore } from '../../packages/store-postgres/src/index';
import { BridgeTransport } from './bridgeTransport';
import type { LeaseOp } from './commands-jobs';
import { verifyClaim } from './invariants';
import type { ModelLease } from './model';
import type { Doorbell } from './store';
import type { RingFault } from './transport';
import type { World } from './world';
import { MAX_DELIVER_DELAY_MS, MODELLED_QUEUES } from './world';

/** Slots per worker. Two, so a bell can find one slot left and a third bell finds none. */
const CONCURRENCY = 2;

/** One processor the bridge holds open: the job it runs ends when a command says how. */
interface Running {
  readonly lease: ModelLease;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Called with the answer to the worker's `complete` or `fail`. */
  onOutcome: ((outcome: Outcome) => void) | null;
  ended: boolean;
}

/**
 * Real `Worker`s inside the model run: a bell the model would give to a claim goes to the
 * worker's own bell handler instead, and a held lease ends by letting the worker's processor
 * return or throw, so the worker's claim, its complete or fail, and the rings and `markRung` that
 * follow are the SDK's own code. The model still checks every answer.
 *
 * The store the workers use is the model's store behind a thin spy: it feeds each claim through
 * `verifyClaim` and into the model (what `ClaimCommand` does), and reports each answer to a
 * `complete` or `fail` back to the command waiting for it. Time stays virtual for the store; the
 * workers' own timers (heartbeat, watchdog) are real and far longer than a run, so they never fire.
 *
 * One `Worker` serves one queue, so a model worker is one `Worker` per queue it is given a bell for.
 */
export class WorkerBridge {
  readonly #store: PostgresStore;
  readonly #workers = new Map<string, { worker: Worker; transport: BridgeTransport }>();
  /** Model lease and store lease of a job the spy has claimed and no processor has picked up yet. */
  readonly #claimed = new Map<string, { model: ModelLease; store: Lease }>();
  readonly #running = new Map<Lease, Running>();
  /** What the workers did, for the tests that check the bridge itself. */
  readonly stats = { delivered: 0, returned: 0, claimed: 0, finished: 0, reaped: 0 };
  #fault: RingFault = 'ok';
  #marks = 0;
  #markWaiters: Array<() => void> = [];
  #failure: unknown = null;

  constructor(private readonly world: World) {
    this.#store = world.store as PostgresStore;
  }

  /** The doorbell a worker's ring lands in: the model's faulty broker, like `World.ring`. */
  ring(items: readonly RingItem[]): RingResult[] {
    const fault = this.#fault;
    this.#fault = 'ok';
    const due = items.filter((item) => (item.deliverAfterMs ?? 0) <= MAX_DELIVER_DELAY_MS);
    this.world.bells.ring(
      due.filter((item) => MODELLED_QUEUES.has(item.bell.queue)).map((item) => item.bell),
      fault
    );
    return items.map((item) =>
      (item.deliverAfterMs ?? 0) <= MAX_DELIVER_DELAY_MS
        ? { ok: true }
        : { ok: false, reason: 'delay-too-long' }
    );
  }

  /** `name` takes the bell. The worker decides what to claim, and a bell it has no slot for goes back. */
  async deliver(name: string, bell: Doorbell): Promise<void> {
    this.#reap();
    const { transport } = await this.#workerFor(name, bell.queue);
    const end = await transport.deliver(bell);
    this.stats.delivered += 1;
    if (end === 'nack') {
      this.stats.returned += 1;
      this.world.bells.ring([bell], 'ok');
    }
    if (this.#failure !== null) {
      const failure = this.#failure;
      this.#failure = null;
      throw failure;
    }
  }

  /**
   * Ends a held lease through its worker: the processor returns (`complete`) or throws (`fail`),
   * and this resolves with the store's answer once the worker has also rung and recorded its
   * bells. `null` when no worker runs the lease, and the caller writes to the store itself.
   */
  async finish(lease: ModelLease, op: LeaseOp, fault: RingFault): Promise<Outcome | null> {
    const run = [...this.#running.values()].find((r) => r.lease === lease && !r.ended);
    if (!run) return null;
    this.#fault = fault;
    const marks = this.#marks;
    const answered = new Promise<Outcome>((resolve) => {
      run.onOutcome = resolve;
    });
    if (op === 'complete') run.resolve({ lease: lease.no });
    else
      run.reject(
        op === 'fail' ? new Error('model failure') : new UnrecoverableError('model failure')
      );
    const outcome = await answered;
    this.stats.finished += 1;
    if (outcome.ok && outcome.rings.some(rungs)) await this.#untilMarks(marks + 1);
    this.#fault = 'ok';
    return outcome;
  }

  /** Aborts what is still running and closes every worker. */
  async close(): Promise<void> {
    for (const run of this.#running.values()) this.#end(run, new Error('run over'));
    await Promise.all(
      [...this.#workers.values()].map(({ worker }) => worker.close({ graceMs: 0, timeout: 1_000 }))
    );
    this.#workers.clear();
  }

  async #workerFor(name: string, queue: string) {
    const key = `${name}/${queue}`;
    let entry = this.#workers.get(key);
    if (!entry) {
      const transport = new BridgeTransport(this);
      const worker = new Worker(queue, this.#processor, {
        store: this.#spy(),
        transport,
        concurrency: CONCURRENCY,
        heartbeatInterval: 0,
        // A claim the model did not deliver a bell for would race its next command.
        claimAgain: false,
        // Never: a drain check is a store read the model did not ask for.
        drainedAfterMs: 3_600_000,
      });
      worker.on('error', () => {});
      entry = { worker: worker as Worker, transport };
      this.#workers.set(key, entry);
      await worker.waitUntilReady();
    }
    return entry;
  }

  /** A processor that returns when a command says so, and throws if its lease is aborted. */
  readonly #processor: Processor = (job, { signal }) => {
    const claimed = this.#claimed.get(job.id);
    this.#claimed.delete(job.id);
    if (!claimed) throw new Error(`no claim recorded for ${job.id}`);
    return new Promise((resolve, reject) => {
      const run: Running = {
        lease: claimed.model,
        resolve,
        reject,
        onOutcome: null,
        ended: false,
      };
      this.#running.set(claimed.store, run);
      signal.addEventListener('abort', () => this.#end(run, signal.reason as Error), {
        once: true,
      });
    });
  };

  #end(run: Running, error: Error): void {
    if (run.ended) return;
    run.ended = true;
    run.reject(error);
  }

  /**
   * A model lease that was given back, expired or recovered without its worker (`release`,
   * `tick`, `recover`) leaves a processor waiting. It is thrown out like a zombie: the worker then
   * writes with a lease nobody holds, and the store must refuse it.
   */
  #reap(): void {
    for (const run of this.#running.values()) {
      if (!run.ended && !this.world.model.held.includes(run.lease)) {
        this.stats.reaped += 1;
        this.#end(run, new Error('lease gone'));
      }
    }
  }

  async #untilMarks(count: number): Promise<void> {
    while (this.#marks < count)
      await new Promise<void>((resolve) => this.#markWaiters.push(resolve));
  }

  /** The model's store as the workers see it: the claim and the answers pass through the model. */
  #spy(): PostgresStore {
    const store = this.#store;
    const world = this.world;
    const answered = (lease: Lease, outcome: Outcome): Outcome => {
      const run = this.#running.get(lease);
      if (run) {
        run.ended = true;
        run.onOutcome?.(outcome);
      }
      return outcome;
    };
    const overrides: Record<string, unknown> = {
      claim: async (
        queue: string,
        owner: string,
        n: number,
        options?: ClaimOptions
      ): Promise<ClaimedJob[]> => {
        world.model.limits.refresh(queue, world.now());
        const claimed = await store.claim(queue, owner, n, options);
        try {
          for (const { item, job } of verifyClaim(world, queue, n, claimed)) {
            const lease = world.model.claim(job, owner, world.now());
            world.tokens.set(lease.no, item.lease);
            this.stats.claimed += 1;
            this.#claimed.set(item.id, { model: lease, store: item.lease });
          }
        } catch (error) {
          // The worker would log this and nack the bell; the harness must fail the run.
          this.#failure ??= error;
        }
        return claimed;
      },
      complete: async (lease: Lease, result: unknown) =>
        answered(lease, await store.complete(lease, result)),
      fail: async (lease: Lease, info: Parameters<PostgresStore['fail']>[1]) =>
        answered(lease, await store.fail(lease, info)),
      markRung: async (entries: readonly RungEntry[]) => {
        try {
          return await store.markRung(entries);
        } finally {
          this.#marks += 1;
          for (const wake of this.#markWaiters.splice(0)) wake();
        }
      },
    };
    return new Proxy(store, {
      get(target, property) {
        if (typeof property === 'string' && property in overrides) return overrides[property];
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

/** A ring the worker records with `markRung`: the transport took it and its job is named. */
function rungs(ring: { readonly dueInMs: number; readonly bell: Doorbell }): boolean {
  return ring.dueInMs <= MAX_DELIVER_DELAY_MS && ring.bell.jobId !== undefined;
}
