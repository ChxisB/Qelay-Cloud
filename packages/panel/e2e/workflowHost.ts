/**
 * The workflow worker of the e2e runtime: the SDK's own `Engine` on the runtime's store and transport,
 * serving three small workflows. It stands in for the application that owns the definitions; the Control
 * API holds none, so an operator action in the panel is carried out here.
 *
 * - `e2e-approval` prepares, waits for an `approved` signal, then finishes.
 * - `e2e-checkout` reserves and charges (both can be rolled back), then fails on `ship`. A run started
 *   with `refundDown` cannot roll `charge` back until `repair(id)` is called: it ends `compensation-stuck`.
 *
 * The engine is a worker, so it shows in the worker registry. It runs only between `start()` and `stop()`:
 * the workflow specs start it (the first `POST /workflow/start` does) and stop it when they are done, and
 * the specs that expect an empty registry never see it.
 */
import type { MemoryTransport } from '@qelay-cloud/transport-local';
import { defineWorkflow, Engine } from '../../sdk/src';
import type { PostgresStore } from '../../store-postgres/src';

interface CheckoutInput {
  readonly refundDown?: boolean;
}

export const WORKFLOW_NAMES = ['e2e-approval', 'e2e-checkout'] as const;

export class WorkflowHost {
  readonly #repaired = new Set<string>();
  #starting: Promise<Engine> | null = null;
  #bells: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: PostgresStore,
    private readonly transport: MemoryTransport
  ) {}

  /** Starts the engine unless it is running; every caller gets the same one. */
  start(): Promise<Engine> {
    this.#starting ??= this.#boot().catch((error) => {
      this.#starting = null;
      throw error;
    });
    return this.#starting;
  }

  async #boot(): Promise<Engine> {
    const engine = new Engine({
      store: this.store,
      transport: this.transport,
      concurrency: 4,
      // Short, so the Workflows page lists the definitions as served within its first poll.
      announceMs: 500,
      heartbeatMs: 500,
    });
    const approval = defineWorkflow('e2e-approval')
      .step('prepare', (ctx) => ({ prepared: String((ctx.input as { order?: string }).order) }), {
        compensate: () => {},
      })
      .waitFor('approved')
      .step('finish', () => ({ shipped: true }));
    const checkout = defineWorkflow('e2e-checkout')
      .step('reserve', () => ({ reserved: true }), { compensate: () => {} })
      .step('charge', () => ({ charged: 1 }), {
        compensate: (ctx) => {
          const input = ctx.input as CheckoutInput;
          if (input.refundDown === true && !this.#repaired.has(ctx.executionId)) {
            throw new Error('refund service unavailable');
          }
        },
        retry: 2,
      })
      .step(
        'ship',
        () => {
          throw new Error('carrier rejected the parcel');
        },
        { retry: 1 }
      );
    await engine.register(approval);
    await engine.register(checkout);
    // MemoryTransport has no timers: it moves a delayed bell only when it is called.
    this.#bells = setInterval(() => this.transport.tick(), 50);
    return engine;
  }

  async run(name: string, input: unknown): Promise<string> {
    const engine = await this.start();
    return (await engine.start(name, input)).id;
  }

  /** Lets `charge` of one `refundDown` run be rolled back from now on. */
  repair(executionId: string): void {
    this.#repaired.add(executionId);
  }

  /** Closes the engine, which takes its row out of the worker registry; `start()` may run again after. */
  async stop(): Promise<void> {
    const starting = this.#starting;
    this.#starting = null;
    if (this.#bells !== null) clearInterval(this.#bells);
    this.#bells = null;
    if (starting !== null) await (await starting.catch(() => null))?.close(true);
  }
}
