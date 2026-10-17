import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { TransportStats } from '@qelay-cloud/core';
import { toError } from './options';

/** `GetQueueAttributes` counts are approximate and may lag by about a minute (AWS documents this). */
export const ATTRIBUTES_LAG_MS = 60_000;
/**
 * CloudWatch publishes SQS metrics once a minute and a sample can arrive some minutes late, so an
 * age is never fresher than this. `stats` adds the cache time on top.
 */
export const CLOUDWATCH_LAG_MS = 300_000;

export const SOURCE_ATTRIBUTES = 'sqs-queue-attributes';
export const SOURCE_ATTRIBUTES_AND_AGE = 'sqs-queue-attributes+cloudwatch';
export const UNAVAILABLE = 'unavailable';

const WINDOW_MS = 600_000;
const FAILURE_CACHE_MS = 10_000;

/** What a transport reports when it has no numbers: every count null, which is never read as zero. */
export function noStats(now: number): TransportStats {
  return {
    depth: null,
    inFlight: null,
    delayed: null,
    oldestAgeMs: null,
    deadLetterDepth: null,
    source: UNAVAILABLE,
    observedAt: now,
    maxStalenessMs: 0,
  };
}

export interface AgeReading {
  /** The age of the oldest bell in the queue, or null when CloudWatch has no sample or was unavailable. */
  readonly oldestAgeMs: number | null;
  /** The same for the dead-letter queue. Counted from the bell's original enqueue time. */
  readonly deadLetterOldestAgeMs: number | null;
  /** False when the reading failed: the ages are unknown, not zero. */
  readonly available: boolean;
}

export interface AgeReaderOptions {
  readonly client: Pick<CloudWatchClient, 'send'>;
  readonly cacheMs: number;
  readonly timeoutMs: number;
  readonly onError: (error: Error) => void;
  /** Tests substitute the clock. */
  readonly now?: () => number;
}

interface Cached {
  readonly at: number;
  readonly ttlMs: number;
  readonly reading: AgeReading;
}

const UNKNOWN: AgeReading = { oldestAgeMs: null, deadLetterOldestAgeMs: null, available: false };

/**
 * `ApproximateAgeOfOldestMessage` from CloudWatch, for a queue and its dead-letter queue in one
 * request, reused for `cacheMs`. Every failure (a denied permission, a throttle, a timeout) becomes
 * an unknown reading and one `onError` call: the dashboard shows "unknown" and the worker loop never
 * sees an exception.
 */
export class AgeReader {
  readonly #options: AgeReaderOptions;
  readonly #cache = new Map<string, Cached>();
  readonly #pending = new Map<string, Promise<AgeReading>>();

  constructor(options: AgeReaderOptions) {
    this.#options = options;
  }

  read(queueName: string, deadLetterName: string): Promise<AgeReading> {
    const now = this.#now();
    const cached = this.#cache.get(queueName);
    if (cached && now - cached.at < cached.ttlMs) return Promise.resolve(cached.reading);
    let pending = this.#pending.get(queueName);
    if (!pending) {
      pending = this.#refresh(queueName, deadLetterName).finally(() =>
        this.#pending.delete(queueName)
      );
      this.#pending.set(queueName, pending);
    }
    return pending;
  }

  async #refresh(queueName: string, deadLetterName: string): Promise<AgeReading> {
    const { cacheMs } = this.#options;
    let reading: AgeReading;
    let ttlMs = cacheMs;
    try {
      reading = await this.#fetch(queueName, deadLetterName);
    } catch (error) {
      this.#options.onError(toError(error));
      reading = UNKNOWN;
      ttlMs = Math.min(cacheMs, FAILURE_CACHE_MS);
    }
    this.#cache.set(queueName, { at: this.#now(), ttlMs, reading });
    return reading;
  }

  async #fetch(queueName: string, deadLetterName: string): Promise<AgeReading> {
    const end = this.#now();
    const query = (id: string, name: string) => ({
      Id: id,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SQS',
          MetricName: 'ApproximateAgeOfOldestMessage',
          Dimensions: [{ Name: 'QueueName', Value: name }],
        },
        Period: 60,
        Stat: 'Maximum',
      },
      ReturnData: true,
    });
    const out = await this.#options.client.send(
      new GetMetricDataCommand({
        StartTime: new Date(end - WINDOW_MS),
        EndTime: new Date(end),
        ScanBy: 'TimestampDescending',
        MetricDataQueries: [query('age', queueName), query('dead', deadLetterName)],
      }),
      { abortSignal: AbortSignal.timeout(this.#options.timeoutMs) }
    );
    const latest = (id: string): number | null => {
      const series = (out.MetricDataResults ?? []).find((result) => result.Id === id);
      // Newest first. No sample in the window means unknown (an idle queue publishes none), not zero.
      const value = series?.Values?.[0];
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.round(value * 1_000))
        : null;
    };
    return {
      oldestAgeMs: latest('age'),
      deadLetterOldestAgeMs: latest('dead'),
      available: true,
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
