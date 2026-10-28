import { testDatabaseUrl } from '../../../test/support/db';
import type {
  BatchProcessor,
  JobWorkerOptions,
  Processor,
  WorkerBatchOptions,
  WorkerOptions,
} from '../src';
import { Worker } from '../src';
import type { SdkFixture } from './support';
import { NAMESPACE } from './support';

/** Polls `check` until it returns a truthy value; fails the test with `what` when `ms` pass first. */
export async function until<V>(
  what: string,
  check: () => V | Promise<V>,
  ms = 5000
): Promise<NonNullable<V>> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<V>;
    if (performance.now() > deadline)
      throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens `Worker`s on the fixture's schema and namespace, as separate processes would, and closes
 * them all. `MemoryTransport` has no timers (it moves bells only when called), so while a worker is
 * open the kit ticks the transport: that is what a broker's own clock does for a delayed bell.
 */
export function workerKit(fixture: () => SdkFixture) {
  const open: Worker<never, unknown>[] = [];
  const transports = new Set<{ tick(): void }>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  const kit = {
    worker<T = unknown, R = unknown>(
      queue: string,
      processor: Processor<T, R>,
      extra: Partial<WorkerOptions> = {}
    ): Worker<T, R> {
      const f = fixture();
      const own: Partial<WorkerOptions> =
        extra.store === undefined
          ? {
              databaseUrl: testDatabaseUrl(),
              database: { schema: f.fresh.name, poolSize: 3 },
              namespace: NAMESPACE,
            }
          : {};
      // `extra.batch` decides which of the two the processor is; the constructor's overloads cannot see through a spread.
      const worker = new Worker<T, R>(
        queue,
        processor as Processor<T, R>,
        {
          transport: f.transport,
          heartbeatInterval: 0,
          ...own,
          ...extra,
        } as JobWorkerOptions
      );
      open.push(worker as unknown as Worker<never, unknown>);
      transports.add((extra.transport as { tick(): void } | undefined) ?? f.transport);
      ticker ??= setInterval(() => transports.forEach((t) => t.tick()), 10);
      return worker;
    },
    /** A worker that runs `processor` over batches of up to `batch.size` jobs. */
    batchWorker<T = unknown, R = unknown>(
      queue: string,
      processor: BatchProcessor<T, R>,
      batch: WorkerBatchOptions,
      extra: Partial<WorkerOptions> = {}
    ): Worker<T, R> {
      return kit.worker<T, R>(queue, processor as unknown as Processor<T, R>, { ...extra, batch });
    },
    async closeAll(): Promise<void> {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      transports.clear();
      await Promise.all(
        open.splice(0).map((worker) => worker.close({ graceMs: 0, timeout: 1000 }))
      );
    },
  };
  return kit;
}
