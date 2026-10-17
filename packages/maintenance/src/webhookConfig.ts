import {
  DEFAULT_DELIVERY_POLICY,
  resolveDeliveryPolicy,
  UnsupportedOptionError,
} from '@qelay-cloud/core';
import type { DeliveryPolicy, WebhookUrlPolicy } from '@qelay-cloud/core';

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_WEBHOOK_BATCH = 50;
export const DEFAULT_WEBHOOK_CONCURRENCY = 8;
export const DEFAULT_WEBHOOK_BUDGET_MS = 5_000;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_LEASE_MS = 30_000;
export const DEFAULT_WEBHOOK_RATE_PER_MINUTE = 60;
/** What a lease must outlast the request timeout by: the chunk's other requests, then the record. */
export const MIN_LEASE_MARGIN_MS = 5_000;

/** What an operator may set. Every field is optional; see the defaults above. */
export interface WebhookSenderOptions {
  /** Deliveries one pass sends at most. 0 turns sending off. */
  readonly batch?: number;
  /** Requests in flight at once. */
  readonly concurrency?: number;
  /** No new chunk of requests starts after this much of a pass. A pass can overrun by one request timeout. */
  readonly budgetMs?: number;
  /** The bound on one attempt, name lookup to answer. */
  readonly timeoutMs?: number;
  /** How long a claimed delivery is its sender's. Must exceed `timeoutMs` by `MIN_LEASE_MARGIN_MS`. */
  readonly leaseMs?: number;
  /** Attempts one webhook gets in a minute. */
  readonly ratePerMinute?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface WebhookSenderConfig {
  readonly urlPolicy: WebhookUrlPolicy;
  readonly retry: DeliveryPolicy;
  readonly batch: number;
  readonly concurrency: number;
  readonly budgetMs: number;
  readonly timeoutMs: number;
  readonly leaseMs: number;
  readonly ratePerMinute: number;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(name, 'must be a positive integer');
  }
  return value;
}

/** The sender's settings, checked; null when `batch` is 0 and the tick sends nothing. */
export function resolveWebhookConfig(
  options: WebhookSenderOptions,
  urlPolicy: WebhookUrlPolicy
): WebhookSenderConfig | null {
  const batch = options.batch ?? DEFAULT_WEBHOOK_BATCH;
  if (batch === 0) return null;
  const timeoutMs = positive('webhook timeoutMs', options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
  const leaseMs = positive('webhook leaseMs', options.leaseMs ?? DEFAULT_WEBHOOK_LEASE_MS);
  if (leaseMs < timeoutMs + MIN_LEASE_MARGIN_MS) {
    throw new UnsupportedOptionError(
      'webhook leaseMs',
      `must be at least timeoutMs + ${MIN_LEASE_MARGIN_MS} ms, or a slow receiver is sent to twice`
    );
  }
  return {
    urlPolicy,
    retry: resolveDeliveryPolicy({
      maxAttempts: options.maxAttempts ?? DEFAULT_DELIVERY_POLICY.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULT_DELIVERY_POLICY.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_DELIVERY_POLICY.maxDelayMs,
    }),
    batch: positive('webhook batch', batch),
    concurrency: positive(
      'webhook concurrency',
      options.concurrency ?? DEFAULT_WEBHOOK_CONCURRENCY
    ),
    budgetMs: positive('webhook budgetMs', options.budgetMs ?? DEFAULT_WEBHOOK_BUDGET_MS),
    timeoutMs,
    leaseMs,
    ratePerMinute: positive(
      'webhook ratePerMinute',
      options.ratePerMinute ?? DEFAULT_WEBHOOK_RATE_PER_MINUTE
    ),
  };
}

const NUMBERS: ReadonlyArray<readonly [string, keyof WebhookSenderOptions]> = [
  ['QCLOUD_WEBHOOK_BATCH', 'batch'],
  ['QCLOUD_WEBHOOK_CONCURRENCY', 'concurrency'],
  ['QCLOUD_WEBHOOK_BUDGET_MS', 'budgetMs'],
  ['QCLOUD_WEBHOOK_TIMEOUT_MS', 'timeoutMs'],
  ['QCLOUD_WEBHOOK_LEASE_MS', 'leaseMs'],
  ['QCLOUD_WEBHOOK_RATE_PER_MINUTE', 'ratePerMinute'],
  ['QCLOUD_WEBHOOK_MAX_ATTEMPTS', 'maxAttempts'],
  ['QCLOUD_WEBHOOK_BASE_DELAY_MS', 'baseDelayMs'],
  ['QCLOUD_WEBHOOK_MAX_DELAY_MS', 'maxDelayMs'],
];

/** The sender's options from the environment. Throws `UnsupportedOptionError` naming the variable. */
export function webhookOptionsFromEnv(env: Env): WebhookSenderOptions {
  const options: Record<string, number> = {};
  for (const [name, key] of NUMBERS) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new UnsupportedOptionError(name, `must be a non-negative integer, not "${raw}"`);
    }
    options[key] = value;
  }
  return options;
}
