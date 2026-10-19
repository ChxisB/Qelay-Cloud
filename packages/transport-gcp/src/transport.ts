import { Duration, PubSub } from '@google-cloud/pubsub';
import type { PublishOptions, Topic } from '@google-cloud/pubsub';
import type {
  DeadLetter,
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
import type { DeadLetterSource, SubscriberStub } from './deadLetters';
import { peekDeadLetters, subscriberSource } from './deadLetters';
import { GRPC_ONLY } from './grpcOnly';
import { MonitoringReader, noStats } from './monitoring';
import { queueNames, environmentNames } from './names';
import type { ErrorSource, PubSubTransportOptions } from './options';
import { DEFAULTS, projectOf, toError } from './options';
import { MAX_RING_BATCH, publishBells, publishSettings } from './publisher';
import { QueueReceiver } from './receiver';

const MONITORING_ENDPOINT = 'https://monitoring.googleapis.com';
/** One pull of a peek waits at most this long, so an empty dead-letter queue answers promptly. */
const PEEK_TIMEOUT_MS = 2_000;

/**
 * `DeliveryTransport` on Google Cloud Pub/Sub: one topic per environment, one subscription per
 * Qelay queue that filters on the bell's route attribute, so a queue's workers see only its bells.
 * A queue named in `hotQueues` has its own topic instead (`names.ts`).
 * Pub/Sub cannot delay a message, so `ring` refuses any delay (`delay-too-long`) and the tick rings
 * the job when it is due. Everything the broker gets wrong (an unreachable service, a missing
 * subscription, a revoked permission) comes back as a result, a report to `onError` or a stream that
 * is opened again: the worker loop and the enqueue path never see an exception from here.
 *
 * Create the topics and subscriptions with Terraform, or with `ensureEnvironment` and `ensureQueue`
 * for an emulator or a test; the transport never creates one.
 */
export class PubSubTransport implements DeliveryTransport, DeadLetterPeek {
  readonly capabilities: TransportCapabilities = {
    maxDeliverDelayMs: 0,
    maxRingBatch: MAX_RING_BATCH,
    attemptCount: 'approximate',
    retryGranularityMs: 1_000,
  };

  readonly #options: PubSubTransportOptions;
  readonly #pubsub: PubSub;
  readonly #ownsClient: boolean;
  readonly #topicOptions: PublishOptions;
  /** The environment's topic and each hot queue's own, by name, built when first used. */
  readonly #topics = new Map<string, Topic>();
  readonly #hot: ReadonlySet<string>;
  readonly #receivers = new Set<QueueReceiver>();
  readonly #monitoring: MonitoringReader | null;
  #deadLetterSource: Promise<DeadLetterSource> | null = null;
  #closed = false;

  constructor(options: PubSubTransportOptions) {
    this.#options = options;
    // Throws `TransportError` for a namespace that cannot be a resource name: a configuration mistake.
    environmentNames(options.namespace);
    this.#hot = new Set(options.hotQueues ?? []);
    // A queue that cannot be a topic name is a configuration mistake: say so here, not on the first ring.
    for (const queue of this.#hot) queueNames(options.namespace, queue, true);
    if (
      options.client === undefined &&
      options.emulatorHost === undefined &&
      process.env.PUBSUB_EMULATOR_HOST
    ) {
      throw new TransportError(
        'PUBSUB_EMULATOR_HOST is set, which would send every bell to an emulator and not to Google Cloud: unset it, or pass `emulatorHost` to say that is what you want'
      );
    }
    this.#ownsClient = options.client === undefined;
    this.#pubsub =
      options.client ??
      new PubSub({
        ...GRPC_ONLY,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.emulatorHost === undefined
          ? {}
          : { apiEndpoint: options.emulatorHost, emulatorMode: true }),
      });
    this.#topicOptions = publishSettings(options.ringRetryBudgetMs ?? DEFAULTS.ringRetryBudgetMs);
    this.#monitoring = this.#buildMonitoring();
  }

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    if (items.length === 0) return [];
    if (this.#closed) return items.map(() => ({ ok: false, reason: 'unreachable' }));
    return publishBells(
      (queue) => this.#topicOf(queue),
      this.#options.namespace,
      items,
      (error) => this.#report(error, 'ring')
    );
  }

  /** Where a queue's bells go: its own topic when it is hot, the environment's otherwise. */
  #topicOf(queue: string): Topic {
    const { topic } = queueNames(this.#options.namespace, queue, this.#hot.has(queue));
    let found = this.#topics.get(topic);
    if (found === undefined) {
      found = this.#pubsub.topic(topic, this.#topicOptions);
      this.#topics.set(topic, found);
    }
    return found;
  }

  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    opts: SubscribeOptions
  ): Subscription {
    if (this.#closed) throw new TransportError('the Pub/Sub transport is closed');
    const { namespace } = this.#options;
    const names = queueNames(namespace, queue);
    const subscription = this.#pubsub.subscription(names.subscription, {
      // The service stops sending past `maxMessages` un-acked bells, and `capacity()` decides which of
      // the held ones start: see QueueReceiver. Excess is allowed so that every bell the service did
      // send reaches the receiver's own queue, where close can give it back: with `false` the client
      // keeps the excess in a list `close` cannot drain, and a WAIT close then takes the whole timeout.
      flowControl: {
        maxMessages: Math.max(1, Math.floor(this.#options.maxHeld ?? DEFAULTS.maxHeld)),
        allowExcessMessages: true,
      },
      // A bell waits un-acked for a slot, so the client must keep extending it for that long.
      maxExtensionTime: Duration.from({
        milliseconds: this.#options.maxExtensionMs ?? DEFAULTS.maxExtensionMs,
      }),
      // The default closes by nacking, which would also redeliver the bells being handled.
      closeOptions: {
        behavior: 'WAIT',
        timeout: Duration.from({
          milliseconds: this.#options.closeTimeoutMs ?? DEFAULTS.closeTimeoutMs,
        }),
      },
    });
    const receiver = new QueueReceiver({
      subscription,
      namespace,
      queue,
      handler,
      capacity: opts.capacity,
      maxNackHoldMs: this.#options.maxNackHoldMs ?? DEFAULTS.maxNackHoldMs,
      onError: (error) => this.#report(error, 'receive'),
      ...(this.#options.streamRestartMs === undefined
        ? {}
        : { restartMs: this.#options.streamRestartMs }),
    });
    this.#receivers.add(receiver);
    receiver.start();
    return {
      refresh: () => receiver.pump(),
      close: async () => {
        this.#receivers.delete(receiver);
        await receiver.close();
      },
    };
  }

  async stats(queue: string): Promise<TransportStats> {
    if (!this.#monitoring) return noStats(Date.now());
    try {
      return await this.#monitoring.stats(queue, queueNames(this.#options.namespace, queue));
    } catch (error) {
      this.#report(error, 'stats');
      return noStats(Date.now());
    }
  }

  /**
   * The bells in a queue's dead-letter subscription, read without acknowledging them and given back
   * at once (see `peekDeadLetters`). It throws when the broker cannot be read: the caller shows that
   * as "unknown", never as an empty list.
   */
  async peekDeadLetters(queue: string, limit: number): Promise<DeadLetter[]> {
    if (this.#closed) throw new TransportError('the Pub/Sub transport is closed');
    const { namespace } = this.#options;
    const names = queueNames(namespace, queue);
    try {
      const [source, project] = await Promise.all([this.#peekSource(), projectOf(this.#pubsub)]);
      return await peekDeadLetters(
        source,
        `projects/${project}/subscriptions/${names.deadLetterSubscription}`,
        { namespace, queue },
        limit
      );
    } catch (error) {
      this.#report(error, 'peek');
      throw error;
    }
  }

  #peekSource(): Promise<DeadLetterSource> {
    const given = this.#options.deadLetterSource;
    if (given !== undefined) return Promise.resolve(given);
    this.#deadLetterSource ??= this.#pubsub
      .getClientAsync_({ client: 'SubscriberClient' })
      .then((client) => subscriberSource(client as unknown as SubscriberStub, PEEK_TIMEOUT_MS));
    // A failed build is tried again on the next peek.
    this.#deadLetterSource.catch(() => {
      this.#deadLetterSource = null;
    });
    return this.#deadLetterSource;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#receivers].map((receiver) => receiver.close()));
    this.#receivers.clear();
    if (this.#ownsClient) {
      try {
        await this.#pubsub.close();
      } catch (error) {
        this.#report(error, 'receive');
      }
    }
  }

  #buildMonitoring(): MonitoringReader | null {
    const { monitoring } = this.#options;
    if (monitoring === false) return null;
    // An emulator has no metrics; a test that points `monitoring` at a stub still gets one.
    if (monitoring === undefined && this.#pubsub.isEmulator) return null;
    const pubsub = this.#pubsub;
    return new MonitoringReader({
      endpoint: monitoring?.endpoint ?? MONITORING_ENDPOINT,
      projectId: async () => monitoring?.projectId ?? (await projectOf(pubsub)),
      accessToken: monitoring?.getAccessToken ?? (() => pubsub.auth.getAccessToken()),
      cacheMs: monitoring?.cacheMs ?? 30_000,
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
