import { UnsupportedOptionError } from '@qelay-cloud/core';

/** The transports a deployment can name with `QCLOUD_TRANSPORT`. */
export const TRANSPORT_KINDS = ['gcp-pubsub', 'aws-sqs', 'postgres'] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const DEFAULT_TRANSPORT_KIND: TransportKind = 'gcp-pubsub';

type Env = Readonly<Record<string, string | undefined>>;

/** Which broker, and the settings only that broker takes. */
export interface TransportSettings {
  readonly transport: TransportKind;
  /** The Google Cloud project of the Pub/Sub transport (`QCLOUD_GCP_PROJECT`). */
  readonly projectId: string | undefined;
  /** The AWS region of the SQS transport (`QCLOUD_AWS_REGION`): explicit, never read from the machine. */
  readonly region: string | undefined;
  /** An SQS endpoint for LocalStack or ElasticMQ (`QCLOUD_AWS_SQS_ENDPOINT`). */
  readonly endpoint: string | undefined;
}

export function isTransportKind(value: string): value is TransportKind {
  return (TRANSPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Reads the transport settings from the environment. Throws `UnsupportedOptionError` naming the
 * variable, and never repeats a value that could be a credential.
 */
export function transportSettingsFromEnv(env: Env): TransportSettings {
  const transport = env.QCLOUD_TRANSPORT || DEFAULT_TRANSPORT_KIND;
  if (!isTransportKind(transport)) {
    throw new UnsupportedOptionError(
      'QCLOUD_TRANSPORT',
      'must be "gcp-pubsub", "aws-sqs" or "postgres"'
    );
  }
  const region = env.QCLOUD_AWS_REGION || undefined;
  if (transport === 'aws-sqs' && region === undefined) {
    throw new UnsupportedOptionError(
      'QCLOUD_AWS_REGION',
      'is required for the SQS transport: the region is never guessed from the machine'
    );
  }
  return {
    transport,
    projectId: env.QCLOUD_GCP_PROJECT || undefined,
    region,
    endpoint: env.QCLOUD_AWS_SQS_ENDPOINT || undefined,
  };
}

/** What a deployment reports about its broker: the name `/capabilities` shows, and whether bells have a dead-letter queue. */
export interface TransportDescription {
  readonly name: string;
  /** False where a bell that nobody can take is not kept anywhere (the Postgres transport polls the store itself). */
  readonly doorbellDeadLetter: boolean;
  /**
   * True where the broker itself documents its message counts as approximate (SQS: eventually consistent,
   * about a minute behind), so a page shows them as estimates rather than exact figures.
   */
  readonly approximateCounts: boolean;
}

export function describeTransport(kind: TransportKind): TransportDescription {
  return kind === 'postgres'
    ? { name: 'postgres-local', doorbellDeadLetter: false, approximateCounts: false }
    : { name: kind, doorbellDeadLetter: true, approximateCounts: kind === 'aws-sqs' };
}
