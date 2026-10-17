import { ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type { Bell, ClaimedJob, Delivery, StateStore, Subscription } from '@qelay-cloud/core';
import type { Ledger } from '../../../test/support/doorbell/ledger';
import { ringAndMark } from '../../../test/support/doorbell/ringing';
import { LOCKED_RECHECK_MS } from '../../sdk/src/workerClaim';
import type { SqsTransport } from '../src';
import { emulatorClient, FAST_VISIBILITY_SECONDS, transportFor } from './support';

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
  /**
   * Whether the transport extends the visibility timeout of a bell this worker holds. Default true.
   * False drops those requests on the way out (a client wrapper, not a switch in the transport), so
   * a slow worker's bell comes back as it would after a network partition.
   */
  readonly heartbeat?: boolean;
  /** How long a bell whose claim hit a database error stays away. Default 1,000, as in the SDK worker. */
  readonly claimErrorRetryMs?: number;
  /** Ring the retry of a job that failed, for its `run_at`. Default true, as in the SDK worker. */
  readonly ringRetries?: boolean;
  /**
   * Claim once more, after `LOCKED_RECHECK_MS`, when a claim finds nothing though a job of the queue
   * is still waiting: the SDK worker's answer to a bell that beats its own `markRung`
   * (`packages/sdk/src/workerClaim.ts`). Default true.
   */
  readonly recheck?: boolean;
}

export interface WorkerStats {
  received: number;
  /** Deliveries with an attempt above 1: a nack, an expired visibility timeout or a crash. */
  redelivered: number;
  malformed: number;
  claims: number;
  emptyClaims: number;
  claimErrors: number;
  /** Claims made a second time after the recheck pause. */
  rechecked: number;
  claimed: number;
  completed: number;
  failed: number;
  /** Bells for a failed job's retry that the broker took. */
  retriesRung: number;
}

export interface TestWorker {
  readonly stats: WorkerStats;
  /** The worker's own transport, for its request counters. */
  readonly transport: SqsTransport;
  /** Stops receiving, waits for the claims and jobs that are running, closes the transport. */
  close(): Promise<void>;
}

const CLAIM_ERROR_RETRY_MS = 1_000;

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
    rechecked: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    retriesRung: 0,
  };
  const client = emulatorClient();
  if (options.heartbeat === false) dropHeartbeats(client);
  const transport = transportFor(namespace, {
    client,
    monitoring: false,
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
    if (outcome.ok && failure === null) stats.completed += 1;
    if (outcome.ok && failure !== null) stats.failed += 1;
    if (options.ringRetries === false) return;
    const taken = await ringAndMark(store, transport, outcome.rings).catch(() => 0);
    if (failure !== null) stats.retriesRung += taken;
  };

  const hasWaiting = async (queue: string): Promise<boolean> => {
    const page = await store.listJobs({ queue, states: ['waiting', 'prioritized'], limit: 1 });
    return page.items.length > 0;
  };

  // The slot is taken before the first await, so the transport's next `capacity()` already sees it.
  const onBell = async (delivery: Delivery): Promise<void> => {
    stats.received += 1;
    if ((delivery.attempt ?? 1) > 1) stats.redelivered += 1;
    const { bell } = delivery;
    if (!bell) {
      // A poison bell: nack it, so the broker redelivers it until it reaches the dead-letter queue.
      stats.malformed += 1;
      await delivery.nack(options.claimErrorRetryMs ?? CLAIM_ERROR_RETRY_MS);
      return;
    }
    used += 1;
    let claimed: ClaimedJob[];
    try {
      await options.hooks?.beforeClaim?.(bell);
      claimed = await store.claim(bell.queue, owner, 1, { leaseMs });
      if (claimed.length === 0 && options.recheck !== false && (await hasWaiting(bell.queue))) {
        stats.rechecked += 1;
        await Bun.sleep(LOCKED_RECHECK_MS);
        claimed = await store.claim(bell.queue, owner, 1, { leaseMs });
      }
    } catch {
      // The database is unreachable: the bell comes back later, and the tick rings as well.
      stats.claimErrors += 1;
      release();
      await delivery.nack(options.claimErrorRetryMs ?? CLAIM_ERROR_RETRY_MS);
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
    transport,
    async close() {
      await Promise.all(subscriptions.map((subscription) => subscription.close()));
      await Promise.all(running);
      await transport.close();
      client.destroy();
    },
  };
}

/**
 * Makes the visibility extensions of the receiver vanish: the transport sends one with the claim
 * window's length every third of it, and nothing else asks for exactly that, so a nack (a different
 * length) still goes through. The wrapper is the test's: the transport has no switch for this.
 */
function dropHeartbeats(client: ReturnType<typeof emulatorClient>): void {
  const send = client.send.bind(client) as (
    command: unknown,
    ...rest: unknown[]
  ) => Promise<unknown>;
  (client as { send: unknown }).send = (command: unknown, ...rest: unknown[]) => {
    if (
      command instanceof ChangeMessageVisibilityCommand &&
      command.input.VisibilityTimeout === FAST_VISIBILITY_SECONDS
    ) {
      return Promise.resolve({});
    }
    return send(command, ...rest);
  };
}
