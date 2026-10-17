import type { RingItem, RingResult } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { MemoryTransportOptions } from '@qelay-cloud/transport-local';
import type { TickOptions } from '../src/config';
import { resolveTickConfig } from '../src/config';
import type { Telemetry } from '../src/telemetry';
import type { TickDeps } from '../src/tick';
import { runTick, runTicks } from '../src/tick';
import type { WebhookSending } from '../src/webhookSender';

export interface Attempt {
  readonly queue: string;
  readonly jobId: string | undefined;
  readonly deliverAfterMs: number;
}

/** A `MemoryTransport` that remembers every ring attempt, and whose next calls can throw as a whole. */
export class RecordingTransport extends MemoryTransport {
  readonly attempts: Attempt[] = [];
  readonly batches: number[] = [];
  #throws = 0;
  #hold: Promise<void> | null = null;

  constructor(options: MemoryTransportOptions = {}) {
    super(options);
  }

  throwNext(n = 1): void {
    this.#throws += n;
  }

  /** The next ring call records itself and then waits until the returned function is called. */
  holdNext(): () => void {
    let release = () => {};
    this.#hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  override async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    this.batches.push(items.length);
    for (const item of items) {
      this.attempts.push({
        queue: item.bell.queue,
        jobId: item.bell.jobId,
        deliverAfterMs: item.deliverAfterMs ?? 0,
      });
    }
    const hold = this.#hold;
    this.#hold = null;
    if (hold) await hold;
    if (this.#throws > 0) {
      this.#throws -= 1;
      throw new Error('broker unreachable');
    }
    return super.ring(items);
  }
}

export interface RecordedTelemetry extends Telemetry {
  readonly durations: Array<[string, number]>;
  readonly gauges: Array<[string, number]>;
  readonly errors: Array<[string, unknown]>;
}

export function recordedTelemetry(): RecordedTelemetry {
  const durations: Array<[string, number]> = [];
  const gauges: Array<[string, number]> = [];
  const errors: Array<[string, unknown]> = [];
  return {
    durations,
    gauges,
    errors,
    duration: (step, ms) => void durations.push([step, ms]),
    gauge: (name, value) => void gauges.push([name, value]),
    error: (step, error) => void errors.push([step, error]),
  };
}

/** A store and a transport wired to the tick: one pass, or one invocation. */
export function ticker(
  store: PostgresStore,
  transport: TickDeps['transport'],
  options: TickOptions = {},
  telemetry?: Telemetry,
  webhooks?: WebhookSending,
  workflows?: TickDeps['workflows']
) {
  const config = resolveTickConfig(transport, options, store);
  const deps: TickDeps = {
    store,
    transport,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(webhooks === undefined ? {} : { webhooks }),
    ...(workflows === undefined ? {} : { workflows }),
  };
  return {
    config,
    deps,
    pass: () => runTick(deps, config),
    run: () => runTicks(deps, config),
  };
}
