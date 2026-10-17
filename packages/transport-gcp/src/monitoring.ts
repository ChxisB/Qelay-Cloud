import type { DeadLetterAge, TransportStats } from '@qelay-cloud/core';
import { toError } from './options';

/**
 * Cloud Monitoring samples Pub/Sub metrics every 60 s and can publish a sample up to 240 s late, so a
 * reading is never fresher than this. `stats` adds the cache time on top.
 */
export const MONITORING_LAG_MS = 300_000;

export const SOURCE = 'cloud-monitoring';
export const UNAVAILABLE = 'unavailable';

const UNDELIVERED = 'pubsub.googleapis.com/subscription/num_undelivered_messages';
const OLDEST_UNACKED = 'pubsub.googleapis.com/subscription/oldest_unacked_message_age';
const WINDOW_MS = 600_000;
const FAILURE_CACHE_MS = 10_000;

export interface MonitoringReaderOptions {
  readonly endpoint: string;
  readonly projectId: () => Promise<string>;
  readonly accessToken: () => Promise<string | null | undefined>;
  readonly cacheMs: number;
  readonly timeoutMs: number;
  readonly onError: (error: Error) => void;
  /** Tests substitute the clock and `fetch`. */
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

export interface QueueSubscriptions {
  readonly subscription: string;
  readonly deadLetterSubscription: string;
}

interface Cached {
  readonly at: number;
  readonly ttlMs: number;
  readonly stats: TransportStats;
}

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

/**
 * Queue depth and age from Cloud Monitoring, one request per queue, reused for `cacheMs`. Every
 * failure (a missing permission, a quota, a timeout, an answer that is not what the API documents)
 * becomes an all-null reading and one `onError` call: the dashboard shows "unknown", and the worker
 * loop never sees an exception.
 */
export class MonitoringReader {
  readonly #options: MonitoringReaderOptions;
  readonly #cache = new Map<string, Cached>();
  readonly #pending = new Map<string, Promise<TransportStats>>();

  constructor(options: MonitoringReaderOptions) {
    this.#options = options;
  }

  stats(queue: string, names: QueueSubscriptions): Promise<TransportStats> {
    const now = this.#now();
    const cached = this.#cache.get(queue);
    if (cached && now - cached.at < cached.ttlMs) return Promise.resolve(cached.stats);
    let pending = this.#pending.get(queue);
    if (!pending) {
      pending = this.#refresh(queue, names).finally(() => this.#pending.delete(queue));
      this.#pending.set(queue, pending);
    }
    return pending;
  }

  async #refresh(queue: string, names: QueueSubscriptions): Promise<TransportStats> {
    const { cacheMs } = this.#options;
    let stats: TransportStats;
    let ttlMs = cacheMs;
    try {
      stats = await this.#read(names);
    } catch (error) {
      this.#options.onError(toError(error));
      stats = { ...noStats(this.#now()), source: SOURCE, maxStalenessMs: 0 };
      ttlMs = Math.min(cacheMs, FAILURE_CACHE_MS);
    }
    this.#cache.set(queue, { at: this.#now(), ttlMs, stats });
    return stats;
  }

  async #read(names: QueueSubscriptions): Promise<TransportStats & DeadLetterAge> {
    const { endpoint, cacheMs, timeoutMs } = this.#options;
    const doFetch = this.#options.fetch ?? fetch;
    const token = await this.#options.accessToken();
    if (!token)
      throw new Error(
        'Cloud Monitoring: no access token (Application Default Credentials not found)'
      );
    const project = await this.#options.projectId();
    const end = this.#now();
    const url = new URL(`/v3/projects/${encodeURIComponent(project)}/timeSeries`, endpoint);
    url.searchParams.set('filter', filterFor(names));
    url.searchParams.set('interval.endTime', new Date(end).toISOString());
    url.searchParams.set('interval.startTime', new Date(end - WINDOW_MS).toISOString());
    url.searchParams.set('pageSize', '20');
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Only the status: the body of an error can echo the request, and nothing here needs it.
      throw new Error(`Cloud Monitoring answered ${response.status}`);
    }
    const series = latestPoints(await response.json());
    const points = [
      series.get(key(UNDELIVERED, names.subscription)),
      series.get(key(OLDEST_UNACKED, names.subscription)),
      series.get(key(UNDELIVERED, names.deadLetterSubscription)),
      series.get(key(OLDEST_UNACKED, names.deadLetterSubscription)),
    ];
    const times = points.flatMap((point) => (point ? [point.at] : []));
    const [depth, oldestAge, dead, deadOldest] = points;
    return {
      depth: depth ? Math.max(0, Math.round(depth.value)) : null,
      // A Pub/Sub bell is never delayed (the tick rings a delayed job when it is due), so none waits at the broker.
      delayed: depth ? 0 : null,
      // The metric counts delivered-but-unacked bells inside the backlog and has no separate figure for them.
      inFlight: null,
      oldestAgeMs: oldestAge ? Math.max(0, Math.round(oldestAge.value * 1_000)) : null,
      deadLetterDepth: dead ? Math.max(0, Math.round(dead.value)) : null,
      deadLetterOldestAgeMs: deadOldest ? Math.max(0, Math.round(deadOldest.value * 1_000)) : null,
      source: SOURCE,
      observedAt: times.length > 0 ? Math.min(...times) : end,
      maxStalenessMs: MONITORING_LAG_MS + cacheMs,
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}

function key(metric: string, subscription: string): string {
  return `${metric}\u0000${subscription}`;
}

function filterFor(names: QueueSubscriptions): string {
  const backlog = `metric.type = "${UNDELIVERED}"`;
  return [
    'resource.type = "pubsub_subscription"',
    `AND ((resource.labels.subscription_id = "${names.subscription}"`,
    `AND (${backlog} OR metric.type = "${OLDEST_UNACKED}"))`,
    `OR (resource.labels.subscription_id = "${names.deadLetterSubscription}"`,
    `AND (${backlog} OR metric.type = "${OLDEST_UNACKED}")))`,
  ].join(' ');
}

interface Point {
  readonly value: number;
  readonly at: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The most recent point of each series, by metric and subscription. Throws when the answer is not a
 * `timeSeries.list` response, so a changed API shows as an error instead of as empty queues.
 */
function latestPoints(body: unknown): Map<string, Point> {
  const root = record(body);
  if (!root) throw new Error('Cloud Monitoring answered with something other than an object');
  const list = root.timeSeries ?? [];
  if (!Array.isArray(list))
    throw new Error('Cloud Monitoring answered with a timeSeries that is not a list');
  const latest = new Map<string, Point>();
  for (const item of list) {
    const series = record(item);
    const metric =
      typeof record(series?.metric)?.type === 'string'
        ? (record(series?.metric)?.type as string)
        : null;
    const labels = record(record(series?.resource)?.labels);
    const subscription =
      typeof labels?.subscription_id === 'string' ? labels.subscription_id : null;
    const points = Array.isArray(series?.points) ? series.points : [];
    if (!metric || !subscription) continue;
    for (const raw of points) {
      const point = record(raw);
      const value = record(point?.value);
      const amount = numeric(value?.int64Value) ?? numeric(value?.doubleValue);
      const endTime = record(point?.interval)?.endTime;
      const at = typeof endTime === 'string' ? Date.parse(endTime) : Number.NaN;
      if (amount === null || Number.isNaN(at)) continue;
      const known = latest.get(key(metric, subscription));
      if (!known || at > known.at) latest.set(key(metric, subscription), { value: amount, at });
    }
  }
  return latest;
}
