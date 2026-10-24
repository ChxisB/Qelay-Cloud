import type { AttemptOutcome, ClaimedDelivery, PostgresStore } from '@qelay-cloud/store-postgres';
import type { Telemetry } from './telemetry';
import { sendUnit, unitsOf } from './webhookBatchSend';
import type { WebhookSenderConfig } from './webhookConfig';
import { Destinations } from './webhookDestinations';
import { createSocketPool } from './webhookPool';
import { cachedResolver, systemResolver } from './webhookSend';
import type { WebhookSending } from './webhookSender';
import { sendDepsOf } from './webhookSender';

/**
 * The webhook sender as a process of its own (`qcloud-tick send`). The tick's step claims a chunk,
 * sends it, records it, and only then claims the next, so one slow receiver holds up the chunk. This
 * loop is pipelined: it keeps up to `concurrency` sends in flight, tops them up from the store as
 * slots free, and records finished ones in a batch (one transaction) while the rest are still on
 * the wire. It pairs with a socket pool, a name cache and a per-destination breaker
 * (`pooledSending`) so a few receivers taking thousands of deliveries do not cost a connection and
 * a lookup each.
 *
 * It is safe next to the tick's sender and other senders: the store hands each delivery to one
 * claimant (`FOR NO KEY UPDATE SKIP LOCKED`) under a lease, and `record` is fenced by attempt number.
 * Sending is bounded by `timeoutMs` and the lease outlasts it (`resolveWebhookConfig`), so a delivery
 * is in two hands only when a sender died.
 *
 * Never throws: a store error is reported to telemetry and the loop looks again after `idleMs`. On
 * stop it lets the sends in flight finish (they end within `timeoutMs`) and records them.
 */

/** Extra time past `timeoutMs` that a stopping loop waits for the sends in flight. */
const STOP_MARGIN_MS = 5_000;

export interface PooledSending {
  readonly sending: WebhookSending;
  /** Closes the idle connections. */
  close(): void;
}

/** The sending seams of `qcloud-tick send`: a socket pool, a name cache and a breaker, from the config. */
export function pooledSending(config: WebhookSenderConfig, ca?: string): PooledSending {
  const pool = createSocketPool({ keepAliveMs: config.keepAliveMs });
  return {
    close: pool.close,
    sending: {
      config,
      post: pool.post,
      resolve:
        config.dnsTtlMs > 0 ? cachedResolver(systemResolver, config.dnsTtlMs) : systemResolver,
      destinations: new Destinations({
        concurrency: config.perDestination,
        failures: config.breakerFailures,
        cooldownMs: config.breakerCooldownMs,
      }),
      ...(ca === undefined ? {} : { ca }),
    },
  };
}

export async function runWebhookLoop(
  store: Pick<PostgresStore, 'webhooks' | 'enqueue'>,
  sending: WebhookSending,
  telemetry: Telemetry,
  signal: AbortSignal
): Promise<void> {
  const { config } = sending;
  const deps = sendDepsOf(sending, (jobs) => store.enqueue(jobs));
  const sends = new Set<Promise<void>>();
  let done: AttemptOutcome[] = [];
  let claimed = 0;
  // Not before this time does the loop ask the store again, after it found nothing (more) due.
  let nextLook = 0;
  let wake: (() => void) | null = null;

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        wake = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, ms));
      signal.addEventListener('abort', finish, { once: true });
      wake = finish;
    });

  // One send is one request: a batch route's deliveries are a unit (D15).
  const start = (unit: readonly ClaimedDelivery[]): void => {
    // `sendUnit` never rejects.
    const send: Promise<void> = sendUnit(unit, deps).then((outcomes) => {
      done.push(...outcomes);
      sends.delete(send);
      wake?.();
    });
    sends.add(send);
  };

  /** Records what finished. On a store error the outcomes stay for the next try. */
  const flush = async (): Promise<void> => {
    const batch = done;
    done = [];
    try {
      const summary = await store.webhooks.record(batch, config.retry);
      telemetry.gauge('webhooks.claimed', claimed);
      telemetry.gauge('webhooks.delivered', summary.delivered);
      telemetry.gauge('webhooks.retrying', summary.retrying);
      telemetry.gauge('webhooks.failed', summary.failed);
      telemetry.gauge('webhooks.stale', summary.stale);
      telemetry.gauge('webhooks.paused', summary.paused);
      telemetry.gauge('webhooks.inflight', sends.size);
      claimed = 0;
    } catch (error) {
      done = [...batch, ...done];
      throw error;
    }
  };

  while (!signal.aborted) {
    try {
      if (done.length > 0) await flush();
      if (signal.aborted) break;
      if (sends.size < config.concurrency && performance.now() >= nextLook) {
        const free = config.concurrency - sends.size;
        const batch = await store.webhooks.claimDue({
          limit: free,
          leaseMs: config.leaseMs,
          ratePerMinute: config.ratePerMinute,
        });
        claimed += batch.length;
        const units = unitsOf(batch);
        for (const unit of units) start(unit);
        nextLook = units.length < free ? performance.now() + config.idleMs : 0;
      }
      if (done.length === 0) {
        const full = sends.size >= config.concurrency;
        if (full || nextLook > performance.now()) {
          await pause(full ? config.idleMs : nextLook - performance.now());
        }
      }
    } catch (error) {
      telemetry.error('webhooks', error);
      await pause(config.idleMs);
    }
  }

  // Stopping: the sends in flight end within their own deadline; a send that does not is left to its lease.
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(sends),
    new Promise((resolve) => {
      cap = setTimeout(resolve, config.timeoutMs + STOP_MARGIN_MS);
    }),
  ]);
  clearTimeout(cap);
  if (done.length > 0) {
    try {
      await flush();
    } catch (error) {
      telemetry.error('webhooks', error);
    }
  }
}
