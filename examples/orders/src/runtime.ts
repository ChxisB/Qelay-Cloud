/**
 * What every process of the example builds first: a database, the store on it, and the doorbell for the
 * chosen transport. A `Queue` or `Worker` is handed the store and the transport, and the process closes
 * both when it is done (`close`).
 *
 * The example imports the workspace sources by path. An application would import the same names from
 * `qelay-cloud` once it is published.
 */
import type { DeliveryTransport } from '../../../packages/core/src';
import { transportWindowMs } from '../../../packages/maintenance/src';
import { openDatabase, PostgresStore } from '../../../packages/store-postgres/src';
import { SqsTransport } from '../../../packages/transport-aws/src';
import { PubSubTransport } from '../../../packages/transport-gcp/src';
import { PostgresLocalTransport } from '../../../packages/transport-local/src';

export interface OrdersEnv {
  readonly databaseUrl: string;
  /** Postgres schema to work in (the tests give each run its own). Unset: the connection's default. */
  readonly schema?: string;
  readonly namespace: string;
  /**
   * `local`: the doorbell is Postgres itself. `gcp`: Pub/Sub, with the infrastructure of `infra/gcp`.
   * `aws`: SQS, with queues from `ensureQueue` or the infrastructure of `infra/aws`.
   */
  readonly transport: 'local' | 'gcp' | 'aws';
  readonly projectId?: string;
  /** The SQS region (`QCLOUD_AWS_REGION`); required for `aws`, never read from the machine. */
  readonly region?: string;
  /** An SQS endpoint of an emulator (`QCLOUD_AWS_SQS_ENDPOINT`). */
  readonly endpoint?: string;
}

/**
 * The same variables the tick service reads (`QCLOUD_DATABASE_URL`, `QCLOUD_NAMESPACE`,
 * `QCLOUD_TRANSPORT`, `QCLOUD_GCP_PROJECT`, `QCLOUD_AWS_REGION`, `QCLOUD_AWS_SQS_ENDPOINT`).
 */
export function ordersEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): OrdersEnv {
  const transport =
    env.QCLOUD_TRANSPORT === 'gcp-pubsub'
      ? 'gcp'
      : env.QCLOUD_TRANSPORT === 'aws-sqs'
        ? 'aws'
        : 'local';
  if (transport === 'aws' && !env.QCLOUD_AWS_REGION) {
    throw new Error('QCLOUD_AWS_REGION is required for QCLOUD_TRANSPORT=aws-sqs');
  }
  return {
    databaseUrl: env.QCLOUD_DATABASE_URL ?? 'postgres://qcloud:qcloud@127.0.0.1:55452/orders',
    namespace: env.QCLOUD_NAMESPACE || 'orders',
    transport,
    ...(env.QCLOUD_GCP_PROJECT ? { projectId: env.QCLOUD_GCP_PROJECT } : {}),
    ...(env.QCLOUD_AWS_REGION ? { region: env.QCLOUD_AWS_REGION } : {}),
    ...(env.QCLOUD_AWS_SQS_ENDPOINT ? { endpoint: env.QCLOUD_AWS_SQS_ENDPOINT } : {}),
  };
}

export interface Runtime {
  readonly db: ReturnType<typeof openDatabase>;
  readonly store: PostgresStore;
  readonly transport: DeliveryTransport;
  close(): Promise<void>;
}

export function openRuntime(env: OrdersEnv): Runtime {
  const db = openDatabase({
    url: env.databaseUrl,
    ...(env.schema === undefined ? {} : { schema: env.schema }),
    poolSize: 4,
    applicationName: 'orders',
  });
  // A transport polls through a store's doorbell, and the store clamps to the transport's window: the
  // first store only reads for the transport, the second is the one the process works with.
  const reader = new PostgresStore({ db, namespace: env.namespace });
  const transport: DeliveryTransport =
    env.transport === 'gcp'
      ? new PubSubTransport({
          namespace: env.namespace,
          ...(env.projectId === undefined ? {} : { projectId: env.projectId }),
        })
      : env.transport === 'aws'
        ? new SqsTransport({
            namespace: env.namespace,
            ...(env.region === undefined ? {} : { region: env.region }),
            ...(env.endpoint === undefined ? {} : { endpoint: env.endpoint }),
          })
        : new PostgresLocalTransport({
            db,
            source: reader.doorbell,
            namespace: env.namespace,
            pollIntervalMs: 250,
          });
  const store = new PostgresStore({
    db,
    namespace: env.namespace,
    ringWindowMs: transportWindowMs(transport),
  });
  return {
    db,
    store,
    transport,
    async close() {
      await transport.close().catch(() => {});
      await db.close({ timeout: 2_000 }).catch(() => {});
    },
  };
}
