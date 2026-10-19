import type { DeliveryTransport, JobOptions, Lease, Outcome } from '@qelay-cloud/core';
import { UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { CompleteBatcher } from './groupComplete';
import type { QueueOptions, TraceHandle, TraceSpan } from './options';
import { checkQueueName, DEFAULT_NAMESPACE, rejectLegacyOptions, ringWindowMs } from './options';

/** What every operation of one `Queue` shares: its name, the store, the doorbell and the sinks. */
export interface Runtime {
  readonly name: string;
  readonly store: PostgresStore;
  readonly transport: DeliveryTransport;
  /** Validated once, merged under the options of every `add`. */
  readonly defaults: JobOptions;
  /** `store.complete`, or with `groupComplete` a share of one `completeMany`. */
  complete(lease: Lease, result: unknown): Promise<Outcome>;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  count(name: string, value?: number, tags?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, tags?: Readonly<Record<string, string>>): void;
  /** Runs `work` in a producer span when tracing is on, with the `traceparent` to store; otherwise just runs it. */
  produce<T>(span: TraceSpan, work: (traceparent: string | undefined) => Promise<T>): Promise<T>;
  /** Runs `work` in a span that continues `traceparent` when tracing is on; otherwise just runs it. */
  consume<T>(
    span: TraceSpan,
    traceparent: string | undefined,
    work: (handle: TraceHandle) => Promise<T>
  ): Promise<T>;
  /** Closes the store when this runtime opened it. Never closes the transport. Idempotent. */
  close(options?: { readonly timeout?: number }): Promise<void>;
}

/** The options that say which store to use: a `Queue`'s, a `Worker`'s and `QueueEvents`' all have them. */
export type StoreSource = Pick<
  QueueOptions,
  'databaseUrl' | 'database' | 'shards' | 'store' | 'namespace' | 'ringCoverMs'
>;

function needsOne(options: StoreSource): void {
  const { databaseUrl, database, shards, store, namespace, ringCoverMs } = options;
  if (store !== undefined) {
    if (
      databaseUrl !== undefined ||
      database !== undefined ||
      shards !== undefined ||
      namespace !== undefined ||
      ringCoverMs !== undefined
    ) {
      throw new UnsupportedOptionError(
        'store',
        'cannot be combined with databaseUrl, database, shards, namespace or ringCoverMs: the store has its own'
      );
    }
    return;
  }
  if (shards !== undefined) {
    if (databaseUrl !== undefined || database !== undefined) {
      throw new UnsupportedOptionError(
        'shards',
        'cannot be combined with databaseUrl or database: the map says which database holds the namespace'
      );
    }
    return;
  }
  if (databaseUrl === undefined && database === undefined) {
    throw new UnsupportedOptionError(
      'databaseUrl',
      'is missing: pass databaseUrl or database (or shards, or a store)'
    );
  }
  if (databaseUrl !== undefined && database?.url !== undefined) {
    throw new UnsupportedOptionError(
      'databaseUrl',
      'conflicts with database.url: give the URL once'
    );
  }
}

/**
 * Builds the store the options name, or takes the one passed in. Opens no connection: the pool
 * connects on first use. `leaseMs` is a worker's `lockDuration`: it sets the store's lease, and a
 * store passed in must already have it, because the store alone decides how far a heartbeat
 * extends a lease.
 */
export function openStore(
  options: StoreSource,
  ringWindow: number,
  leaseMs?: number
): { readonly store: PostgresStore; readonly owned: boolean } {
  needsOne(options);
  if (options.store !== undefined) {
    if (leaseMs !== undefined && options.store.leaseMs !== leaseMs) {
      throw new UnsupportedOptionError(
        'lockDuration',
        `is ${leaseMs} but the store's leaseMs is ${options.store.leaseMs}: the store sets how far a heartbeat extends a lease, so give the store the same leaseMs or leave lockDuration out`
      );
    }
    return { store: options.store, owned: false };
  }
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const store = new PostgresStore({
    db: openDatabase(
      options.shards?.databaseFor(namespace) ?? {
        ...options.database,
        ...(options.databaseUrl === undefined ? {} : { url: options.databaseUrl }),
      }
    ),
    namespace,
    ringWindowMs: ringWindow,
    ...(options.ringCoverMs === undefined ? {} : { ringCoverMs: options.ringCoverMs }),
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
  return { store, owned: true };
}

const NO_HANDLE: TraceHandle = { event() {}, fail() {} };

/** Validates the options and builds the store, as `openStore` does. */
export function openRuntime(
  name: string,
  options: QueueOptions,
  worker: { readonly leaseMs?: number; readonly groupComplete?: number } = {}
): Runtime {
  rejectLegacyOptions(options);
  checkQueueName(name);
  if (options.transport === undefined || options.transport === null) {
    throw new UnsupportedOptionError('transport', 'is required: pass a DeliveryTransport');
  }
  const defaults = validateJobOptions(options.defaultJobOptions);
  const { transport, logger, metrics, tracing } = options;
  const { store, owned } = openStore(options, ringWindowMs(transport), worker.leaseMs);
  let closing: Promise<void> | null = null;
  const completes =
    worker.groupComplete === undefined
      ? undefined
      : new CompleteBatcher(store, worker.groupComplete, (size) =>
          runtime.observe('qcloud.worker.complete_group_size', size)
        );
  const runtime: Runtime = {
    name,
    store,
    transport,
    defaults,
    complete: (lease, result) =>
      completes === undefined ? store.complete(lease, result) : completes.complete(lease, result),
    warn(message, context) {
      try {
        logger?.warn(message, context);
      } catch {
        // A broken logger must not turn a job that was admitted into a failed add.
      }
    },
    count(metric, value, tags) {
      try {
        metrics?.increment(metric, value ?? 1, tags);
      } catch {
        // Same for a broken metrics sink.
      }
    },
    observe(metric, value, tags) {
      try {
        metrics?.observe?.(metric, value, tags);
      } catch {
        // Same again.
      }
    },
    produce(span, work) {
      if (tracing === undefined) return work(undefined);
      let started = false;
      try {
        return tracing.produce(span, (traceparent) => {
          started = true;
          return work(traceparent);
        });
      } catch (error) {
        // A tracer that throws before it starts the work must not fail the add; one that throws after is the work's own error.
        if (started) throw error;
        return work(undefined);
      }
    },
    consume(span, traceparent, work) {
      if (tracing === undefined) return work(NO_HANDLE);
      let started = false;
      try {
        return tracing.consume(span, traceparent, (handle) => {
          started = true;
          return work(handle);
        });
      } catch (error) {
        if (started) throw error;
        return work(NO_HANDLE);
      }
    },
    close(closeOptions) {
      if (!owned) return Promise.resolve();
      closing ??= store.close(closeOptions);
      return closing;
    },
  };
  return runtime;
}
