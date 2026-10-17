import type { DeliveryTransport, Ring, RingItem, RingResult } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { TickOptions } from '../src/config';
import { ringDue } from '../src/ring';
import { recordedTelemetry, ticker } from './support';

/** A small seeded generator (mulberry32), so a failing run replays from its seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** How the run's time passes: a manual clock the harness moves, or real timers. */
export interface ChaosTime {
  now(): number;
  /** Lets `ms` go by. */
  pass(ms: number): Promise<void>;
  /** Lets every bell that can be delivered right now be delivered and handled. */
  settle(): Promise<void>;
}

interface BellLog {
  readonly at: number;
  /** When the bell is due: the attempt's time plus its relative delay. */
  readonly dueAt: number;
}

/**
 * Wraps a transport so that a share of the rings are reported `ok` and then lost, as a broker can,
 * and records every ring attempt per job. The ring of a bell without a job id is passed through.
 */
export class LossyTransport implements Pick<
  DeliveryTransport,
  'capabilities' | 'ring' | 'subscribe'
> {
  readonly capabilities: DeliveryTransport['capabilities'];
  dropRate: number;
  readonly attempts = new Map<string, BellLog[]>();
  dropped = 0;
  forwarded = 0;

  constructor(
    private readonly inner: DeliveryTransport,
    private readonly random: () => number,
    private readonly now: () => number,
    dropRate: number
  ) {
    this.capabilities = inner.capabilities;
    this.dropRate = dropRate;
  }

  subscribe: DeliveryTransport['subscribe'] = (queue, handler, options) =>
    this.inner.subscribe(queue, handler, options);

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    const results: RingResult[] = [];
    const sent: Array<{ index: number; item: RingItem }> = [];
    items.forEach((item, index) => {
      const at = this.now();
      const { jobId } = item.bell;
      if (jobId !== undefined) {
        const log = this.attempts.get(jobId) ?? [];
        log.push({ at, dueAt: at + Math.ceil(item.deliverAfterMs ?? 0) });
        this.attempts.set(jobId, log);
      }
      if (this.random() < this.dropRate) {
        this.dropped += 1;
        results[index] = { ok: true };
      } else {
        sent.push({ index, item });
      }
    });
    if (sent.length > 0) {
      this.forwarded += sent.length;
      const taken = await this.inner.ring(sent.map(({ item }) => item));
      sent.forEach(({ index }, n) => {
        results[index] = taken[n]!;
      });
    }
    return results;
  }

  /** The latest time any bell of the job is due, or `-Infinity`. */
  lastBellDue(jobId: string): number {
    return Math.max(-Infinity, ...(this.attempts.get(jobId) ?? []).map((log) => log.dueAt));
  }
}

export interface ChaosOptions {
  readonly store: PostgresStore;
  readonly inner: DeliveryTransport;
  readonly time: ChaosTime;
  readonly seed: number;
  readonly queues: readonly string[];
  /** Share of rings lost after being reported `ok`. */
  readonly dropRate: number;
  /** Share of claims whose worker dies holding the job. */
  readonly crashRate: number;
  /**
   * Most times a worker dies holding one job. A queue's `maxStalls` (3 by default) fails a job that
   * stalls that often, by design, so the harness stays under it to keep "completes" meaningful.
   */
  readonly maxCrashesPerJob?: number;
  /** Share of enqueued jobs that are delayed, by up to `maxDelayMs`. */
  readonly delayedShare: number;
  readonly maxDelayMs: number;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly stepMs: number;
  /** Steps with faults; then `drainSteps` without. */
  readonly steps: number;
  readonly drainSteps: number;
  /** Scheduling jitter the bound allows beyond one step, for real timers. */
  readonly jitterMs: number;
  readonly tick?: TickOptions;
  /** False runs no ticks at all: the control that shows the checks can fail. Default true. */
  readonly ticks?: boolean;
  /** What the database holds for a job, for the message when it breaks the bound. */
  readonly describeJob?: (id: string) => Promise<string>;
  /** The `attempts` the database holds for each job, read at the end. */
  readonly attemptsOf: (ids: readonly string[]) => Promise<Map<string, number>>;
}

interface Meta {
  /** When the job can first be claimed, or can next be claimed after a worker died holding it. */
  claimableSince: number;
  claims: number;
  crashes: number;
  completions: number;
}

export interface ChaosResult {
  readonly enqueued: number;
  readonly completed: number;
  readonly crashes: number;
  readonly dropped: number;
  readonly forwarded: number;
  readonly doubleCompleted: number;
  /** Jobs whose `attempts` is not the number of times a worker died holding them. */
  readonly attemptMismatches: number;
  readonly notCompleted: number;
  /** The longest a claimable job went with no bell due, beyond its last bell (ms), and the bound. */
  readonly worstBellGapMs: number;
  readonly boundMs: number;
  readonly violations: string[];
  readonly telemetryErrors: number;
}

/**
 * Enqueues at random, loses rings, kills workers at random, runs ticks, and checks after every step
 * that no claimable job has gone longer without a bell than `reRingAfterMs` plus one tick
 * interval (invariant 3). A crashed worker's job counts as claimable from its lease's end, so the
 * same check gives the lease plus two intervals from the crash. After the faults stop, everything
 * that was enqueued must complete exactly once.
 */
export async function runChaos(o: ChaosOptions): Promise<ChaosResult> {
  const random = seeded(o.seed);
  const reRingAfterMs = o.tick?.reRingAfterMs ?? o.intervalMs;
  const boundMs = reRingAfterMs + o.intervalMs + o.stepMs + o.jitterMs;
  const transport = new LossyTransport(o.inner, random, () => o.time.now(), o.dropRate);
  const telemetry = recordedTelemetry();
  const tick = ticker(
    o.store,
    transport,
    { intervalMs: o.intervalMs, reRingAfterMs, ringGraceMs: 0, ...o.tick },
    telemetry
  );
  const jobs = new Map<string, Meta>();
  const violations: string[] = [];
  let crashRate = o.crashRate;
  let worstBellGapMs = 0;

  const subscriptions = o.queues.map((queue) =>
    o.inner.subscribe(
      queue,
      async (delivery) => {
        const claimed = await o.store.claim(queue, 'chaos-worker', 1);
        await delivery.ack();
        for (const job of claimed) {
          const meta = jobs.get(job.id)!;
          meta.claims += 1;
          if (meta.crashes < (o.maxCrashesPerJob ?? 2) && random() < crashRate) {
            // The worker dies holding the job: no heartbeat, no outcome. It is claimable again
            // when the lease ends, and only the tick can notice.
            meta.crashes += 1;
            meta.claimableSince = o.time.now() + o.leaseMs;
            continue;
          }
          if (await o.store.complete(job.lease, 'ok')) meta.completions += 1;
        }
      },
      { capacity: () => 8 }
    )
  );

  const enqueue = async (): Promise<void> => {
    const count = Math.floor(random() * 4);
    if (count === 0) return;
    const now = o.time.now();
    const delays = Array.from({ length: count }, () =>
      random() < o.delayedShare ? Math.ceil(random() * o.maxDelayMs) : 0
    );
    const created = await o.store.enqueue(
      delays.map((delay, n) => ({
        queue: o.queues[Math.floor(random() * o.queues.length)]!,
        data: n,
        options: { delay, attempts: 1_000, backoff: 0 },
      }))
    );
    const rings: Ring[] = [];
    created.forEach((job, n) => {
      jobs.set(job.id, {
        claimableSince: now + delays[n]!,
        claims: 0,
        crashes: 0,
        completions: 0,
      });
      if (job.ring) rings.push(job.ring);
    });
    // The enqueuer rings what it created, through the same lossy broker.
    await ringDue({ store: o.store, transport, telemetry }, rings);
  };

  const check = async (): Promise<void> => {
    const now = o.time.now();
    for (const [id, meta] of jobs) {
      if (meta.completions > 0 || now < meta.claimableSince) continue;
      const since = Math.max(meta.claimableSince, transport.lastBellDue(id));
      worstBellGapMs = Math.max(worstBellGapMs, now - since);
      if (now - since > boundMs && violations.length < 5) {
        violations.push(
          `${await o.describeJob?.(id)} job ${id}: ${now - since} ms without a bell due, bound ${boundMs} ms ` +
            `(claimable since ${meta.claimableSince}, now ${now}, crashes ${meta.crashes}, ` +
            `rings at ${JSON.stringify((transport.attempts.get(id) ?? []).slice(-4).map((log) => [log.at, log.dueAt]))})`
        );
      }
    }
  };

  let nextTick = o.time.now() + o.intervalMs;
  const step = async (faults: boolean): Promise<void> => {
    if (faults) await enqueue();
    await o.time.pass(o.stepMs);
    await o.time.settle();
    if (o.time.now() >= nextTick) {
      if (o.ticks !== false) await tick.run();
      nextTick += o.intervalMs;
      await o.time.settle();
    }
    await check();
  };

  for (let n = 0; n < o.steps; n += 1) await step(true);
  transport.dropRate = 0;
  crashRate = 0;
  for (let n = 0; n < o.drainSteps; n += 1) await step(false);
  await Promise.all(subscriptions.map((subscription) => subscription.close()));

  return finish(o, jobs, transport, violations, worstBellGapMs, boundMs, telemetry.errors.length);
}

async function finish(
  o: ChaosOptions,
  jobs: Map<string, Meta>,
  transport: LossyTransport,
  violations: string[],
  worstBellGapMs: number,
  boundMs: number,
  telemetryErrors: number
): Promise<ChaosResult> {
  const metas = [...jobs.values()];
  const attempts = await o.attemptsOf([...jobs.keys()]);
  return {
    enqueued: jobs.size,
    completed: metas.filter((meta) => meta.completions === 1).length,
    crashes: metas.reduce((sum, meta) => sum + meta.crashes, 0),
    dropped: transport.dropped,
    forwarded: transport.forwarded,
    doubleCompleted: metas.filter((meta) => meta.completions > 1).length,
    attemptMismatches: [...jobs].filter(([id, meta]) => attempts.get(id) !== meta.crashes).length,
    notCompleted: metas.filter((meta) => meta.completions === 0).length,
    worstBellGapMs,
    boundMs,
    violations,
    telemetryErrors,
  };
}
