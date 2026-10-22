/** What `stats` takes and gives (`webhookStats.ts`). */

export interface StatsQuery {
  /** The window, epoch milliseconds, over the deliveries' event times. At most `MAX_STATS_WINDOW_MS` long. */
  readonly since: number;
  readonly until: number;
  /** Only this webhook's. */
  readonly webhook?: string;
  /** How many equal slices of the window the chart has. Default 24, at most `MAX_STATS_BUCKETS`. */
  readonly buckets?: number;
}

/** One slice of the window. Latency is of the attempts the receiver answered; null when there were none. */
export interface StatsBucket {
  readonly from: number;
  readonly delivered: number;
  readonly failed: number;
  /** Still pending or being sent. */
  readonly pending: number;
  readonly avgLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

export interface WebhookStats {
  readonly since: number;
  readonly until: number;
  /** The width of a bucket, ms. */
  readonly bucketMs: number;
  readonly delivered: number;
  readonly failed: number;
  readonly pending: number;
  /** `failed / (delivered + failed)`; null when nothing has finished. */
  readonly failureRatio: number | null;
  /** Attempts per finished delivery; null when nothing has finished. */
  readonly avgAttempts: number | null;
  /** Deliveries that are waiting or being sent now, whatever the window, and the event time of the oldest. */
  readonly backlog: number;
  readonly oldestPendingAt: number | null;
  readonly latency: {
    readonly avgMs: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  } | null;
  readonly buckets: readonly StatsBucket[];
}

/** What `statsByWebhook` takes: the window and slices of `StatsQuery`, for every webhook at once. */
export type GroupStatsQuery = Pick<StatsQuery, 'since' | 'until' | 'buckets'>;

/** One slice of one webhook's window: counts only (the latency read is per webhook). */
export interface GroupBucket {
  readonly from: number;
  readonly delivered: number;
  readonly failed: number;
  readonly pending: number;
}

/** One webhook's numbers over the window; they equal what `stats({ webhook })` answers for the same window. */
export interface WebhookGroupStat {
  readonly webhookId: string;
  readonly delivered: number;
  readonly failed: number;
  readonly pending: number;
  /** `failed / (delivered + failed)`; null when nothing has finished. */
  readonly failureRatio: number | null;
  /** Deliveries waiting or being sent now, whatever the window, and the event time of the oldest. */
  readonly backlog: number;
  readonly oldestPendingAt: number | null;
  readonly buckets: readonly GroupBucket[];
}

export interface WebhookGroupStats {
  readonly since: number;
  readonly until: number;
  readonly bucketMs: number;
  /** Every webhook of the namespace, by id, with zeros for one that had no events. */
  readonly groups: readonly WebhookGroupStat[];
}
