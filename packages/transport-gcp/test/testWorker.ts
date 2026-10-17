import type { Bell, ClaimedJob, Delivery, StateStore, Subscription } from '@qelay-cloud/core';
import type { Ledger } from '../../../test/support/doorbell/ledger';
import { ringAndMark } from '../../../test/support/doorbell/ringing';
import { PubSubTransport } from '../src';
import { EMULATOR_PROJECT, emulatorHost } from './support';

/** Fault hooks. Each may stall, or never return to model a process that dies at that point. */
export interface WorkerHooks {
  beforeClaim?(bell: Bell): Promise<void>;
  /** After the claim attempt, before the ack. */
  beforeAck?(claimed: readonly ClaimedJob[], bell: Bell): Promise<void>;
}

export interface WorkerOptions {
  readonly owner: string;
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly process?: (job: ClaimedJob) => Promise<unknown>;
  readonly hooks?: WorkerHooks;
  /** The client stops extending a held bell's ack deadline after this long. Default: the transport's. */
  readonly maxExtensionMs?: number;
}

export interface WorkerStats {
  received: number;
  /** Deliveries with an attempt above 1: a nack, an expired deadline or a crash. */
  redelivered: number;
  malformed: number;
  claims: number;
  emptyClaims: number;
  claimErrors: number;
  claimed: number;
  completed: number;
}

export interface TestWorker {
  readonly stats: WorkerStats;
  /** Stops pulling, waits for the claims and jobs that are running, closes the transport. */
  close(): Promise<void>;
}

/** How long a bell whose claim hit a database error stays held before it comes back. */
const CLAIM_ERROR_RETRY_MS = 500;

/**
 * A pull worker as the runtime builds one on `DeliveryTransport` (DESIGN.md, "Worker loop"): the
 * transport hands a bell over only while `capacity()` is above zero, the handler makes one claim
 * attempt for it and acks, and the job then runs in the background under its slot. The ack follows
 * the claim attempt, never the job: the lease protects the job, the bell only wakes the worker.
 */
export function startWorker(
  store: StateStore,
  namespace: string,
  ledger: Ledger,
  options: WorkerOptions
): TestWorker {
  const { owner, concurrency, leaseMs } = options;
  const stats: WorkerStats = {
    received: 0,
    redelivered: 0,
    malformed: 0,
    claims: 0,
    emptyClaims: 0,
    claimErrors: 0,
    claimed: 0,
    completed: 0,
  };
  const transport = new PubSubTransport({
    namespace,
    projectId: EMULATOR_PROJECT,
    emulatorHost: emulatorHost(),
    ...(options.maxExtensionMs !== undefined && { maxExtensionMs: options.maxExtensionMs }),
    onError: (error, source) => console.error(`[${owner}] ${source}: ${error.message}`),
  });
  const subscriptions: Subscription[] = [];
  const running = new Set<Promise<void>>();
  let used = 0;

  const release = (): void => {
    used -= 1;
    for (const subscription of subscriptions) subscription.refresh();
  };

  const runJob = async (claim: ClaimedJob): Promise<void> => {
    const start = Date.now();
    const heartbeat = setInterval(() => {
      void store.heartbeat(claim.lease).catch(() => {});
    }, leaseMs / 3);
    let result: unknown = null;
    let failure: string | null = null;
    try {
      result = (await options.process?.(claim)) ?? null;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(heartbeat);
      ledger.ran(claim.id, owner, start);
    }
    const startedAt = Date.now();
    const outcome =
      failure === null
        ? await store.complete(claim.lease, result)
        : await store.fail(claim.lease, { message: failure, unrecoverable: false });
    ledger.settled(claim.id, owner, claim.lease.token, outcome.ok, startedAt);
    if (outcome.ok) stats.completed += 1;
    await ringAndMark(store, transport, outcome.rings).catch(() => {});
  };

  // The slot is taken before the first await, so the transport's next `capacity()` already sees it.
  const onBell = async (delivery: Delivery): Promise<void> => {
    stats.received += 1;
    if ((delivery.attempt ?? 1) > 1) stats.redelivered += 1;
    const { bell } = delivery;
    if (!bell) {
      // A poison bell: nack it, so the broker redelivers it until it reaches the dead-letter topic.
      stats.malformed += 1;
      await delivery.nack();
      return;
    }
    used += 1;
    let claimed: ClaimedJob[];
    try {
      await options.hooks?.beforeClaim?.(bell);
      claimed = await store.claim(bell.queue, owner, 1, { leaseMs });
    } catch {
      // The database is unreachable: the bell comes back later, and the tick rings as well.
      stats.claimErrors += 1;
      release();
      await delivery.nack(CLAIM_ERROR_RETRY_MS);
      return;
    }
    stats.claims += 1;
    if (claimed.length === 0) stats.emptyClaims += 1;
    for (const claim of claimed) ledger.claimed(claim.id, owner, claim.lease.token);
    stats.claimed += claimed.length;
    if (claimed.length === 0) used -= 1;
    await options.hooks?.beforeAck?.(claimed, bell);
    await delivery.ack();
    for (const claim of claimed) {
      const job = runJob(claim).finally(() => {
        running.delete(job);
        release();
      });
      running.add(job);
    }
  };

  for (const queue of options.queues) {
    subscriptions.push(
      transport.subscribe(queue, onBell, { capacity: () => Math.max(0, concurrency - used) })
    );
  }

  return {
    stats,
    async close() {
      await Promise.all(subscriptions.map((subscription) => subscription.close()));
      await Promise.all(running);
      await transport.close();
    },
  };
}
