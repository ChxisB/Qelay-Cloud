/**
 * The worker: claims jobs when a bell rings and runs them. Where the tick runs is a deployment choice:
 * on the local transport this process runs it (`ORDERS_TICK` is not `off`), which is what fires the cron
 * entry and rings delayed and retried jobs on time. On GCP the tick is its own service (infra/gcp), so
 * the worker leaves it off and a delayed or retried job waits for the scheduler's next minute.
 */
import { TickLoop } from '../../../packages/maintenance/src';
import { Worker } from '../../../packages/sdk/src';
import type { Ledger, Order } from './jobs';
import { ordersProcessor, QUEUE } from './jobs';
import type { Runtime } from './runtime';
import { openRuntime, ordersEnv } from './runtime';

export interface Running {
  readonly worker: Worker<Order, string>;
  readonly tick: TickLoop | null;
  stop(): Promise<void>;
}

export function startWorker(
  runtime: Runtime,
  ledger: Ledger,
  options: { readonly tickEveryMs?: number | null } = {}
): Running {
  const worker = new Worker(QUEUE, ordersProcessor(ledger), {
    store: runtime.store,
    transport: runtime.transport,
    concurrency: 5,
  });
  const every = options.tickEveryMs === undefined ? 5_000 : options.tickEveryMs;
  const tick =
    every === null
      ? null
      : new TickLoop(
          { store: runtime.store, transport: runtime.transport },
          { intervalMs: every, ringGraceMs: Math.min(2_000, every), worstLatenessMs: 1_000 }
        );
  tick?.start();
  return {
    worker,
    tick,
    async stop() {
      await worker.close();
      await tick?.stop();
    },
  };
}

if (import.meta.main) {
  const env = ordersEnv();
  const runtime = openRuntime(env);
  const ledger: Ledger = new Map();
  const off = process.env.ORDERS_TICK === 'off' || env.transport === 'gcp';
  const running = startWorker(runtime, ledger, { tickEveryMs: off ? null : 5_000 });
  running.worker.on('failed', (job, error) =>
    console.log(`failed ${job.name} ${job.id}: ${error.message}`)
  );
  running.worker.on('completed', (job) => console.log(`completed ${job.name} ${job.id}`));
  console.log(
    `worker on queue ${QUEUE}, transport ${env.transport}, tick ${off ? 'off' : 'in process'}`
  );
  const stop = new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await stop;
  await running.stop();
  await runtime.close();
}
