import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { SQSClient } from '@aws-sdk/client-sqs';

/** Where an error the transport swallowed came from: it never throws from the paths a worker loop runs. */
export type ErrorSource = 'ring' | 'receive' | 'stats' | 'peek';

export interface MonitoringOptions {
  /** A CloudWatch client to use instead of building one (a test passes a stub). Not closed by the transport. */
  readonly client?: Pick<CloudWatchClient, 'send'>;
  /** A CloudWatch endpoint, for LocalStack. Default: the region's. */
  readonly endpoint?: string;
  /** How long one reading of the age metrics is reused. They are sampled every 60 s. Default 60,000. */
  readonly cacheMs?: number;
  /** A reading that takes longer is given up on. Default 5,000. */
  readonly timeoutMs?: number;
}

export interface SqsTransportOptions {
  /** The environment this transport serves: its queues carry only bells of this namespace. */
  readonly namespace: string;
  /**
   * The AWS region, explicit: the transport does not guess one from the machine. Required unless
   * `client` is given.
   */
  readonly region?: string;
  /**
   * An SQS endpoint, for LocalStack or ElasticMQ. Without it the client talks to the region's SQS
   * and, unless `monitoring` says otherwise, reads queue age from CloudWatch. With it, CloudWatch is
   * left off by default (an emulator has no metrics).
   */
  readonly endpoint?: string;
  /**
   * Fixed credentials. Default: the AWS default credential chain (environment, shared profile, web
   * identity, container and instance roles). They are never logged or returned.
   */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** A client to use instead of building one, for shared credentials or a test. The transport does not close it. */
  readonly client?: SQSClient;
  /** How long `ring` keeps retrying a transient failure before it reports `unreachable`. Default 10,000. */
  readonly ringRetryBudgetMs?: number;
  /** Long-poll wait of one receive: 0 to 20 seconds. Default 20. */
  readonly waitSeconds?: number;
  /**
   * The claim window: how long a received bell is invisible to other workers. It is sent with every
   * receive, so it does not depend on the queue's own setting, and a bell that is still being
   * claimed has it extended every third of it. Default 30 seconds.
   */
  readonly visibilityTimeoutSeconds?: number;
  /** The longest a `nack(retryInMs)` keeps a bell away. SQS allows 12 hours. Default 3,600,000. */
  readonly maxNackHoldMs?: number;
  /** How long `close` waits for the handlers still running. Default 15,000. */
  readonly closeTimeoutMs?: number;
  /** First wait after a failed receive; doubles up to 5,000. Default 250. */
  readonly receiveBackoffMs?: number;
  /**
   * Where the age of the oldest bell comes from. Default: CloudWatch on AWS, nothing behind a custom
   * `endpoint`. `false` turns it off: `stats` then answers the counts without an age.
   */
  readonly monitoring?: MonitoringOptions | false;
  /** Called with errors the transport handled, for the logger. Never given a message body. */
  readonly onError?: (error: Error, source: ErrorSource) => void;
}

export const DEFAULTS = {
  ringRetryBudgetMs: 10_000,
  waitSeconds: 20,
  visibilityTimeoutSeconds: 30,
  maxNackHoldMs: 3_600_000,
  closeTimeoutMs: 15_000,
  receiveBackoffMs: 250,
} as const;

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
