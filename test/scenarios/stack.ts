import { randomBytes } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { DeliveryTransport } from '../../packages/core/src';
import { resolveWorkflowConfig, TickLoop, transportWindowMs } from '../../packages/maintenance/src';
import type { TickLoopOptions, WorkflowSweepOptions } from '../../packages/maintenance/src';
import type {
  FlowProducerOptions,
  Processor,
  QueueOptions,
  WorkerOptions,
} from '../../packages/sdk/src';
import { FlowProducer, Queue, Worker } from '../../packages/sdk/src';
import { migrate, PostgresStore } from '../../packages/store-postgres/src';
import type { FreshSchema } from '../../packages/store-postgres/test/helpers';
import { freshSchema } from '../../packages/store-postgres/test/helpers';
import * as sqsSupport from '../../packages/transport-aws/test/support';
import { environmentNames, PubSubTransport } from '../../packages/transport-gcp/src';
import type { Environment } from '../../packages/transport-gcp/test/support';
import {
  EMULATOR_PROJECT,
  emulatorHost,
  openEnvironment,
} from '../../packages/transport-gcp/test/support';
import { MemoryTransport, PostgresLocalTransport } from '../../packages/transport-local/src';
import { testDatabaseUrl } from '../support/db';
import { FaultyTransport } from '../support/faults/faultyTransport';
import type { StackName } from '../support/transports';

export type StackKind = StackName;

/** The queue every scenario uses unless it asks for more. Pub/Sub needs each queue provisioned up front. */
export const QUEUE = 'jobs';

export interface StackOptions {
  readonly queues?: readonly string[];
  /** The in-process tick's interval. The scenarios run it fast so they last seconds, not minutes. */
  readonly tickIntervalMs?: number;
  /** How long a freshly created job is left alone by the tick, in case its own publish is in flight. */
  readonly ringGraceMs?: number;
  /** How many tick loops run, as separate processes' would, all on the one database. Default 1. */
  readonly tickLoops?: number;
  /** Turns on the tick's workflow step (waits that ran out, runs that stopped moving). Off by default. */
  readonly workflows?: WorkflowSweepOptions;
}

/**
 * One complete deployment in the process: a migrated schema, a transport of the given kind, the
 * Queue and Worker of the SDK, and an in-process `TickLoop` that repairs and schedules. Workers
 * get a transport each (a separate process would), except on `memory`, whose bells never leave the
 * process that rang them.
 */
export interface Stack {
  readonly kind: StackKind;
  readonly namespace: string;
  readonly fresh: FreshSchema;
  /** A store on the schema, for the crons and for reading what happened behind the SDK's back. */
  readonly store: PostgresStore;
  /** Rings like the producer's transport, but a scenario can make the broker misbehave: see `FaultyTransport`. */
  readonly ring: FaultyTransport;
  readonly loops: readonly TickLoop[];
  queue<T = unknown>(extra?: Partial<QueueOptions>, name?: string): Queue<T>;
  /** A `FlowProducer` ringing through `ring`, like `queue`. */
  flows(extra?: Partial<FlowProducerOptions>): FlowProducer;
  worker<T = unknown, R = unknown>(
    processor: Processor<T, R>,
    extra?: Partial<WorkerOptions>,
    name?: string
  ): Worker<T, R>;
  /** A transport of this stack's kind that a worker, or the test, can own. */
  transport(): DeliveryTransport;
  /**
   * Puts a body that is not a bell into the broker's queue for `queue`, as a foreign or buggy producer
   * would. Absent where the broker has no message body to spoil (memory, Postgres).
   */
  readonly poison?: (queue: string) => Promise<void>;
  /** How long a malformed bell takes to reach the dead-letter queue on this broker, with room to spare. */
  readonly deadLetterAfterMs?: number;
  /** Rows of `qcloud_jobs` by state, for the reconciliation at the end of a scenario. */
  states(queue?: string): Promise<Record<string, number>>;
  stopTicks(): Promise<void>;
  drop(): Promise<void>;
}

const POLL_MS = 50;

interface Factory {
  make(): DeliveryTransport;
  /** True when every holder must share the one instance (a `MemoryTransport` is private to its process). */
  readonly shared: boolean;
  readonly poison?: (queue: string) => Promise<void>;
  readonly deadLetterAfterMs?: number;
  dispose(): Promise<void>;
}

async function transportFactory(
  kind: StackKind,
  namespace: string,
  fresh: FreshSchema,
  reader: PostgresStore,
  queues: readonly string[]
): Promise<Factory> {
  if (kind === 'memory') {
    const memory = new MemoryTransport();
    // It has no timers of its own: this is what a broker's clock does for a delayed or returned bell.
    const timer = setInterval(() => memory.tick(), 10);
    return {
      make: () => memory,
      shared: true,
      dispose: async () => {
        clearInterval(timer);
        await memory.close();
      },
    };
  }
  if (kind === 'postgres') {
    const channel = `qcloud_scn_${randomBytes(6).toString('hex')}`;
    return {
      make: () =>
        new PostgresLocalTransport({
          db: fresh.db,
          source: reader.doorbell,
          namespace,
          channel,
          pollIntervalMs: POLL_MS,
          visibilityTimeoutMs: 2_000,
          heartbeatMs: 1_000,
        }),
      shared: false,
      dispose: async () => {},
    };
  }
  if (kind === 'sqs') {
    const sqs = await sqsSupport.openEnvironment({ namespace, queues });
    return {
      make: () =>
        sqsSupport.transportFor(namespace, {
          onError: (error, source) => console.error(`[scenarios] sqs ${source}: ${error.message}`),
        }),
      shared: false,
      deadLetterAfterMs: 25_000,
      async poison(queue) {
        await sqs.client.send(
          new SendMessageCommand({
            QueueUrl: sqs.provisioned(queue).queueUrl,
            MessageBody: 'this is not a bell {',
          })
        );
      },
      dispose: () => sqs.destroy(),
    };
  }
  const env: Environment = await openEnvironment({ namespace, queues });
  return {
    make: () =>
      new PubSubTransport({
        namespace,
        projectId: EMULATOR_PROJECT,
        emulatorHost: emulatorHost(),
        onError: (error, source) => console.error(`[scenarios] pubsub ${source}: ${error.message}`),
      }),
    shared: false,
    deadLetterAfterMs: 40_000,
    async poison(queue) {
      await env.pubsub.topic(environmentNames(namespace).topic).publishMessage({
        data: Buffer.from('this is not a bell'),
        attributes: { route: env.names(queue).route },
      });
    },
    dispose: () => env.destroy(),
  };
}

export async function openStack(kind: StackKind, options: StackOptions = {}): Promise<Stack> {
  const queues = options.queues ?? [QUEUE];
  const namespace = `scn${randomBytes(5).toString('hex')}`;
  const fresh = await freshSchema({ poolSize: 6 });
  await migrate(fresh.db);
  // The transport reads the doorbell through a store, and the store clamps its ring window to the
  // transport's: so the transport is built over a first store, as the CLI does, and the tick's over a second.
  const factory = await transportFactory(
    kind,
    namespace,
    fresh,
    new PostgresStore({ db: fresh.db, namespace }),
    queues
  );
  const producer = factory.make();
  const store = new PostgresStore({
    db: fresh.db,
    namespace,
    ringWindowMs: transportWindowMs(producer),
  });
  const ring = new FaultyTransport(producer);
  const opened: Array<{ close(options?: object): Promise<void> }> = [];
  const own = (): Pick<QueueOptions, 'databaseUrl' | 'database' | 'namespace'> => ({
    databaseUrl: testDatabaseUrl(),
    database: { schema: fresh.name, poolSize: 3 },
    namespace,
  });

  const tickOptions: TickLoopOptions = {
    intervalMs: options.tickIntervalMs ?? 200,
    ringGraceMs: options.ringGraceMs ?? 100,
    worstLatenessMs: 100,
  };
  const workflows =
    options.workflows === undefined ? null : resolveWorkflowConfig(options.workflows);
  const loops = Array.from(
    { length: options.tickLoops ?? 1 },
    (_, n) =>
      new TickLoop(
        {
          store:
            n === 0
              ? store
              : new PostgresStore({ db: fresh.db, namespace, ringWindowMs: store.ringWindowMs }),
          transport: producer,
          ...(workflows === null ? {} : { workflows }),
        },
        { ...tickOptions, holder: `scenario-${n}` }
      )
  );
  for (const loop of loops) loop.start();

  const stack: Stack = {
    kind,
    namespace,
    fresh,
    store,
    ring,
    loops,
    queue<T>(extra: Partial<QueueOptions> = {}, name = QUEUE) {
      const queue = new Queue<T>(name, { transport: ring, ...own(), ...extra } as QueueOptions);
      opened.push(queue);
      return queue;
    },
    flows(extra: Partial<FlowProducerOptions> = {}) {
      const producer = new FlowProducer({
        transport: ring,
        ...own(),
        ...extra,
      } as FlowProducerOptions);
      opened.push(producer);
      return producer;
    },
    worker<T, R>(
      processor: Processor<T, R>,
      extra: Partial<WorkerOptions> = {},
      name = QUEUE
    ): Worker<T, R> {
      const transport = extra.transport ?? factory.make();
      const worker = new Worker<T, R>(name, processor, {
        transport,
        ...own(),
        heartbeatInterval: 0,
        closeTransport: !factory.shared && extra.transport === undefined,
        ...extra,
      } as WorkerOptions);
      opened.push(worker as unknown as { close(options?: object): Promise<void> });
      return worker;
    },
    transport: () => factory.make(),
    ...(factory.poison === undefined ? {} : { poison: factory.poison }),
    ...(factory.deadLetterAfterMs === undefined
      ? {}
      : { deadLetterAfterMs: factory.deadLetterAfterMs }),
    async states(queue) {
      const rows = await fresh.sql<Array<{ state: string; n: string }>>`
        SELECT state, count(*) AS n FROM qcloud_jobs
        WHERE namespace = ${namespace} AND (${queue ?? null}::text IS NULL OR queue = ${queue ?? null})
        GROUP BY state`;
      return Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]));
    },
    async stopTicks() {
      await Promise.all(loops.map((loop) => loop.stop({ timeout: 2_000 })));
    },
    async drop() {
      await stack.stopTicks();
      await Promise.all(
        opened
          .splice(0)
          .map((handle) => handle.close({ timeout: 1_000, graceMs: 0 }).catch(() => {}))
      );
      if (!factory.shared) await producer.close().catch(() => {});
      await factory.dispose().catch(() => {});
      await fresh.drop();
    },
  };
  return stack;
}
