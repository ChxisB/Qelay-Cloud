import type { DeliveryTransport } from '@qelay-cloud/core';
import { SqsTransport } from '@qelay-cloud/transport-aws';
import { PubSubTransport } from '@qelay-cloud/transport-gcp';
import type { LocalDatabase, QueueSource } from '@qelay-cloud/transport-local';
import { PostgresLocalTransport } from '@qelay-cloud/transport-local';
import type { TransportSettings } from './settings';

export interface OpenTransportOptions {
  readonly namespace: string;
  /** What the Postgres transport polls. Required for `postgres`, ignored by the cloud transports. */
  readonly local?: { readonly db: LocalDatabase; readonly source: QueueSource };
  /**
   * True for a process that only rings (the tick): it never asks for queue statistics, so the SQS
   * transport is built without CloudWatch.
   */
  readonly ringOnly?: boolean;
}

/**
 * The one place that turns a transport name into a transport. Everything else (the SDK, the store,
 * the tick, the API) sees a `DeliveryTransport` and its declared capabilities, so a difference between
 * brokers is a capability flag and not a branch (`scripts/check-transport-boundary.ts` enforces it).
 */
export function openTransport(
  settings: TransportSettings,
  options: OpenTransportOptions
): DeliveryTransport {
  const { namespace } = options;
  if (settings.transport === 'postgres') {
    if (options.local === undefined) {
      throw new Error(
        'openTransport: the postgres transport needs `local` (a database and a source)'
      );
    }
    return new PostgresLocalTransport({ ...options.local, namespace });
  }
  if (settings.transport === 'aws-sqs') {
    return new SqsTransport({
      namespace,
      ...(settings.region === undefined ? {} : { region: settings.region }),
      ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
      ...(options.ringOnly === true ? { monitoring: false } : {}),
    });
  }
  return new PubSubTransport({
    namespace,
    ...(settings.projectId === undefined ? {} : { projectId: settings.projectId }),
    ...(settings.hotQueues.length === 0 ? {} : { hotQueues: settings.hotQueues }),
  });
}
