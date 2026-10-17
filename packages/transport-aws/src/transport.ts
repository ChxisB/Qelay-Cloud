import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type {
  DeadLetter,
  DeadLetterAge,
  DeadLetterPeek,
  Delivery,
  DeliveryTransport,
  RingItem,
  RingResult,
  SubscribeOptions,
  Subscription,
  TransportCapabilities,
  TransportStats,
} from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { peekDeadLetters } from './deadLetters';
import type { SqsMetrics } from './metrics';
import { newMetrics } from './metrics';
import {
  AgeReader,
  ATTRIBUTES_LAG_MS,
  CLOUDWATCH_LAG_MS,
  noStats,
  SOURCE_ATTRIBUTES,
  SOURCE_ATTRIBUTES_AND_AGE,
} from './monitoring';
import { queueNames, requireNamespace } from './names';
import type { ErrorSource, SqsTransportOptions } from './options';
import { DEFAULTS, toError } from './options';
import { MAX_DELAY_SECONDS, MAX_RING_BATCH, publishBells } from './publisher';
import { QueueUrls } from './queueUrls';
import { QueueReceiver } from './receiver';

const STATS_ATTRIBUTES = [
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
] as const;

/**
 * `DeliveryTransport` on Amazon SQS: one standard queue per Qelay queue per environment, each with
 * its own dead-letter queue (see `names.ts`), so a bell for queue A cannot reach a subscriber of
 * queue B. Standard queues deliver at least once and may reorder; the doorbell model does not mind.
 *
 * Everything the broker gets wrong (an unreachable service, a missing queue, a revoked permission)
 * comes back as a result, a report to `onError` or a receive that is tried again: the worker loop and
 * the enqueue path never see an exception from here.
 *
 * Create the queues with Terraform, or with `ensureQueue` for an emulator or a test; the transport
 * never creates one. Authentication is the AWS default credential chain unless `credentials` is set.
 */
export class SqsTransport implements DeliveryTransport, DeadLetterPeek {
  readonly capabilities: TransportCapabilities = {
    maxDeliverDelayMs: MAX_DELAY_SECONDS * 1_000,
    maxRingBatch: MAX_RING_BATCH,
    attemptCount: 'approximate',
    retryGranularityMs: 1_000,
  };

  /** What the transport asked of SQS, for the cost arithmetic and for tests. Live, not a copy. */
  readonly metrics: SqsMetrics = newMetrics();

  readonly #options: SqsTransportOptions;
  readonly #client: SQSClient;
  readonly #ownsClient: boolean;
  readonly #urls: QueueUrls;
  readonly #receivers = new Set<QueueReceiver>();
  readonly #ages: AgeReader | null;
  readonly #ageCacheMs: number;
  #ownCloudWatch: CloudWatchClient | null = null;
  #closed = false;

  constructor(options: SqsTransportOptions) {
    this.#options = options;
    // Throws `TransportError` for a namespace that cannot be a resource name: a configuration mistake.
    requireNamespace(options.namespace);
    if (options.client === undefined && !options.region) {
      throw new TransportError('the SQS transport needs a region (QCLOUD_AWS_REGION)');
    }
    this.#ownsClient = options.client === undefined;
    this.#client = options.client ?? this.#buildClient(options);
    this.#urls = new QueueUrls(this.#client, this.metrics);
    this.#ageCacheMs = options.monitoring ? (options.monitoring.cacheMs ?? 60_000) : 60_000;
    this.#ages = this.#buildAges();
  }

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    if (items.length === 0) return [];
    if (this.#closed) return items.map(() => ({ ok: false, reason: 'unreachable' }));
    return publishBells(
      {
        client: this.#client,
        urls: this.#urls,
        namespace: this.#options.namespace,
        metrics: this.metrics,
        budgetMs: this.#options.ringRetryBudgetMs ?? DEFAULTS.ringRetryBudgetMs,
        onError: (error) => this.#report(error, 'ring'),
      },
      items
    );
  }

  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    opts: SubscribeOptions
  ): Subscription {
    if (this.#closed) throw new TransportError('the SQS transport is closed');
    const { namespace } = this.#options;
    const names = queueNames(namespace, queue);
    const receiver = new QueueReceiver({
      client: this.#client,
      urls: this.#urls,
      metrics: this.metrics,
      namespace,
      queue,
      queueName: names.queue,
      handler,
      capacity: opts.capacity,
      waitSeconds: clamp(this.#options.waitSeconds ?? DEFAULTS.waitSeconds, 0, 20),
      visibilitySeconds: clamp(
        Math.ceil(this.#options.visibilityTimeoutSeconds ?? DEFAULTS.visibilityTimeoutSeconds),
        1,
        43_200
      ),
      maxNackHoldMs: this.#options.maxNackHoldMs ?? DEFAULTS.maxNackHoldMs,
      closeTimeoutMs: this.#options.closeTimeoutMs ?? DEFAULTS.closeTimeoutMs,
      backoffMs: this.#options.receiveBackoffMs ?? DEFAULTS.receiveBackoffMs,
      onError: (error) => this.#report(error, 'receive'),
    });
    this.#receivers.add(receiver);
    receiver.start();
    return {
      refresh: () => receiver.refresh(),
      close: async () => {
        this.#receivers.delete(receiver);
        await receiver.close();
      },
    };
  }

  /**
   * Counts from `GetQueueAttributes` (approximate by SQS's own definition, so `maxStalenessMs` is
   * 60 s) and, when CloudWatch answers, the age of the oldest bell. A number that could not be read
   * is null, never zero; a queue that cannot be read at all answers `unavailable`.
   */
  async stats(queue: string): Promise<TransportStats & DeadLetterAge> {
    try {
      const names = queueNames(this.#options.namespace, queue);
      let deadError: unknown = null;
      const [main, dead, age] = await Promise.all([
        this.#attributes(names.queue),
        this.#attributes(names.deadLetter).catch((error: unknown) => {
          // A queue without its dead-letter queue still has counts of its own.
          deadError = error;
          return null;
        }),
        this.#ages ? this.#ages.read(names.queue, names.deadLetter) : null,
      ]);
      if (deadError !== null) this.#report(deadError, 'stats');
      const deadLetterDepth = dead === null ? null : sum(dead);
      const aged = age?.available === true ? age : null;
      return {
        depth: main.visible,
        inFlight: main.notVisible,
        delayed: main.delayed,
        oldestAgeMs: aged ? aged.oldestAgeMs : null,
        deadLetterDepth,
        deadLetterOldestAgeMs: aged ? aged.deadLetterOldestAgeMs : null,
        source: aged ? SOURCE_ATTRIBUTES_AND_AGE : SOURCE_ATTRIBUTES,
        observedAt: Date.now(),
        maxStalenessMs: aged ? CLOUDWATCH_LAG_MS + this.#ageCacheMs : ATTRIBUTES_LAG_MS,
      };
    } catch (error) {
      this.#report(error, 'stats');
      return noStats(Date.now());
    }
  }

  /**
   * The bells in a queue's dead-letter queue, received with a visibility timeout of 0 and never
   * deleted (see `peekDeadLetters`). It throws when the broker cannot be read: the caller shows that
   * as "unknown", never as an empty list.
   */
  async peekDeadLetters(queue: string, limit: number): Promise<DeadLetter[]> {
    if (this.#closed) throw new TransportError('the SQS transport is closed');
    const { namespace } = this.#options;
    const names = queueNames(namespace, queue);
    try {
      const url = await this.#urls.url(names.deadLetter);
      this.metrics.receiveCalls += 1;
      return await peekDeadLetters(this.#client, url, { namespace, queue }, limit);
    } catch (error) {
      this.#report(error, 'peek');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#receivers].map((receiver) => receiver.close()));
    this.#receivers.clear();
    if (this.#ownsClient) this.#client.destroy();
    this.#ownCloudWatch?.destroy();
  }

  async #attributes(name: string): Promise<{
    visible: number | null;
    notVisible: number | null;
    delayed: number | null;
  }> {
    const url = await this.#urls.url(name);
    const out = await this.#client.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [...STATS_ATTRIBUTES] })
    );
    const read = (key: (typeof STATS_ATTRIBUTES)[number]): number | null => {
      const value = out.Attributes?.[key];
      const parsed = value === undefined ? Number.NaN : Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    return {
      visible: read('ApproximateNumberOfMessages'),
      notVisible: read('ApproximateNumberOfMessagesNotVisible'),
      delayed: read('ApproximateNumberOfMessagesDelayed'),
    };
  }

  #buildClient(options: SqsTransportOptions): SQSClient {
    const waitMs = (options.waitSeconds ?? DEFAULTS.waitSeconds) * 1_000;
    return new SQSClient({
      region: options.region,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      // One attempt: `ring` owns its retries so that its budget is real, a receive has its own
      // backoff, and a delete or visibility change that fails is only a harmless redelivery.
      maxAttempts: 1,
      // The longest request is a long poll; a connection that hangs past it is dead.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: waitMs + 10_000 },
    });
  }

  #buildAges(): AgeReader | null {
    const { monitoring, endpoint, region, credentials } = this.#options;
    if (monitoring === false) return null;
    // An emulator has no CloudWatch; a test that points `monitoring` at a stub still gets one.
    if (monitoring === undefined && endpoint !== undefined) return null;
    let client = monitoring?.client;
    if (client === undefined) {
      this.#ownCloudWatch = new CloudWatchClient({
        region: region ?? this.#client.config.region,
        ...(monitoring?.endpoint === undefined ? {} : { endpoint: monitoring.endpoint }),
        ...(credentials === undefined ? {} : { credentials }),
        maxAttempts: 1,
      });
      client = this.#ownCloudWatch;
    }
    return new AgeReader({
      client,
      cacheMs: this.#ageCacheMs,
      timeoutMs: monitoring?.timeoutMs ?? 5_000,
      onError: (error) => this.#report(error, 'stats'),
    });
  }

  #report(error: unknown, source: ErrorSource): void {
    try {
      this.#options.onError?.(toError(error), source);
    } catch {
      // A logger that throws must not take the worker loop down with it.
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
}

/** Visible plus in flight plus delayed; null when any part could not be read. */
function sum(parts: {
  visible: number | null;
  notVisible: number | null;
  delayed: number | null;
}): number | null {
  const { visible, notVisible, delayed } = parts;
  if (visible === null || notVisible === null || delayed === null) return null;
  return visible + notVisible + delayed;
}
