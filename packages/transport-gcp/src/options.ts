import type { PubSub } from '@google-cloud/pubsub';
import type { DeadLetterSource } from './deadLetters';

/** Where an error the transport swallowed came from: it never throws from the paths a worker loop runs. */
export type ErrorSource = 'ring' | 'receive' | 'stats' | 'peek';

export interface MonitoringOptions {
  /** Default `https://monitoring.googleapis.com`. A test points it at a stub. */
  readonly endpoint?: string;
  /** The project whose metrics are read. Default: the Pub/Sub client's. */
  readonly projectId?: string;
  /** Default: the Pub/Sub client's own credentials (Application Default Credentials). */
  readonly getAccessToken?: () => Promise<string | null | undefined>;
  /** How long one reading is reused. The metrics are sampled every 60 s, so more often only costs quota. Default 30,000. */
  readonly cacheMs?: number;
  /** A reading that takes longer is given up on. Default 5,000. */
  readonly timeoutMs?: number;
}

export interface PubSubTransportOptions {
  /** The environment this transport serves: its topic carries only bells of this namespace. */
  readonly namespace: string;
  /** The Google Cloud project. Default: whatever Application Default Credentials resolve to. */
  readonly projectId?: string;
  /**
   * A Pub/Sub emulator, as `host:port`. Sets the client to emulator mode, so it never reaches
   * Google Cloud and needs no credentials. This is the only way in: a `PUBSUB_EMULATOR_HOST` in the
   * environment without it is refused, so a variable that leaks into a deployment cannot hide there.
   */
  readonly emulatorHost?: string;
  /**
   * Queues that have their own topic and an unfiltered subscription (`ensureQueue(..., { hot: true })`,
   * or Terraform's `hot = true`), for a queue busy enough that the shared topic's filters would cost
   * it. Every process of a deployment, publishers and workers alike, must be given the same list.
   * Default: none, every queue on the environment's topic.
   */
  readonly hotQueues?: readonly string[];
  /** A client to use instead of building one, for shared credentials or a test. The transport does not close it. */
  readonly client?: PubSub;
  /** How long `ring` keeps retrying a transient failure before it reports `unreachable`. Default 10,000. */
  readonly ringRetryBudgetMs?: number;
  /**
   * Most bells this process holds un-acked per subscription: the ones whose claim attempt is running
   * plus the ones waiting for capacity. Server-side flow control is fixed when a stream opens, so
   * this is static; `capacity()` decides which of them start. A held bell is invisible to other
   * workers, so keep it small. Default 8.
   */
  readonly maxHeld?: number;
  /** The client extends the ack deadline of a held bell for at most this long. Default 3,600,000. */
  readonly maxExtensionMs?: number;
  /** The longest `nack(retryInMs)` keeps a bell before returning it. Default 30,000. */
  readonly maxNackHoldMs?: number;
  /** How long `close` waits for the bells being handled before it gives them back. Default 15,000. */
  readonly closeTimeoutMs?: number;
  /**
   * A stream that ended with a fatal error (a missing subscription, a revoked permission) is opened
   * again after this long, then after twice as long, up to 30,000. Default 1,000.
   */
  readonly streamRestartMs?: number;
  /**
   * Where queue depth comes from. Default: Cloud Monitoring on Google Cloud, nothing on an emulator
   * (which has no metrics). `false` turns it off, and `stats` then answers `unavailable`.
   */
  readonly monitoring?: MonitoringOptions | false;
  /**
   * Where `peekDeadLetters` reads the dead-letter subscription from. Default: the client library's
   * subscriber client. A test passes a stub.
   */
  readonly deadLetterSource?: DeadLetterSource;
  /** Called with errors the transport handled, for the logger. Never given a message body. */
  readonly onError?: (error: Error, source: ErrorSource) => void;
}

export const DEFAULTS = {
  ringRetryBudgetMs: 10_000,
  maxHeld: 8,
  maxExtensionMs: 3_600_000,
  maxNackHoldMs: 30_000,
  closeTimeoutMs: 15_000,
} as const;

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The client's project: the one it was built with, or else the one Application Default Credentials resolve to. */
export async function projectOf(pubsub: PubSub): Promise<string> {
  const known = pubsub.projectId;
  // The client keeps a `{{projectId}}` placeholder until it has resolved one.
  if (known && !known.startsWith('{{')) return known;
  return pubsub.auth.getProjectId();
}
