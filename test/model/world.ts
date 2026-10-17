import { CronModel } from './cronModel';
import type { ModelLease } from './model';
import { QueueModel } from './reference';
import type { DlqEntry, JobState, Lease, Ring, StateStore, TickBudget } from './store';
import type { RingFault, VirtualClock } from './transport';
import { FaultyDoorbells } from './transport';
import type { WorkerBridge } from './workers';

export const NAMESPACE = 'model';
export const QUEUES = ['alpha', 'beta'] as const;
export const MODELLED_QUEUES: ReadonlySet<string> = new Set(QUEUES);
export const WORKERS = ['w0', 'w1'] as const;
export const CUSTOM_IDS = ['custom-0', 'custom-1'] as const;
/** Upstream's DEFAULT_LOCK_TTL. */
export const LOCK_TTL_MS = 30_000;
/** One sweep interval. `tick` advances the clock by this much, and it is the re-ring threshold. */
export const TICK_INTERVAL_MS = 10_000;
/** The harness transport is shaped like Pub/Sub: no per-message delay, so the tick rings delayed jobs. */
export const MAX_DELIVER_DELAY_MS = 0;
/**
 * Generous caps, so the model sees no cap effects (a capped backlog takes several ticks, and the
 * ring-query tests cover that). The ring parameters mirror the fake store's: a bell is stale after
 * one sweep interval, a fresh job has no grace, and the transport holds no delayed bell.
 */
export const TICK_BUDGET: TickBudget = {
  maxDurationMs: 5_000,
  maxRingsPerQueue: 10_000,
  maxItems: 10_000,
  reRingAfterMs: TICK_INTERVAL_MS,
  ringGraceMs: 0,
  ringWindowMs: MAX_DELIVER_DELAY_MS,
};

/**
 * Every named check, keyed by the task 02 invariant it serves (I1-I5) or by the ordering, claim,
 * transition and model rules. A target enables all of them unless it opts out.
 */
export const CHECKS = {
  'I1.noLoss': 'A job the model holds, live or terminal, is never missing from the store.',
  'I1.noResurrection':
    'A completed, failed or cancelled generation never becomes live or claimable again.',
  'I2.singleLiveLease':
    'No job is claimed while it is active, and an active job has exactly the lease the model gave.',
  'I2.staleTokenRejected': 'A stale or expired lease token never renews, completes or fails a job.',
  'I3.nothingStuck':
    'After a tick, every claimable job in an unpaused queue has a deliverable doorbell.',
  'I4.attemptsCounted':
    'Attempts match the model: fail and an expired lease count, a claim does not.',
  'I4.attemptsBounded': 'attempts never exceeds maxAttempts.',
  'I5.dlqExactlyOnce':
    'A failed job has exactly one DLQ entry, never rewritten; no other job has one.',
  'ORDER.priority': 'A claim never skips a higher-priority claimable job.',
  'ORDER.lifo': 'At equal priority, LIFO jobs come first, newest first.',
  'ORDER.fifo': 'FIFO jobs come by runAt, then oldest first.',
  'ORDER.delay': 'A delayed job is never claimed before its runAt.',
  'CLAIM.count': 'A claim takes min(n, claimable, limit room) jobs, all from the requested queue.',
  'CLAIM.limits':
    'A claim never takes more than the rate window or the concurrency limit has room for.',
  'CLAIM.paused': 'A claim on a paused queue takes nothing.',
  'T.legalTransition': 'Every observed state change is in the transition table.',
  'MODEL.state': 'getJob reports the state and generation the model expects.',
  'MODEL.outcome': 'An operation succeeds exactly when the model says it may.',
  'CRON.exactlyOnce':
    'Each due occurrence of a cron creates exactly one job, however many ticks run at once; one that was missed is not made up.',
} as const;

export type CheckName = keyof typeof CHECKS;
export const ALL_CHECKS = Object.keys(CHECKS) as CheckName[];

export class InvariantViolation extends Error {
  constructor(
    readonly check: CheckName,
    detail: string
  ) {
    super(`[${check}] ${detail}`);
    this.name = 'InvariantViolation';
  }
}

interface Observation {
  readonly generation: number;
  readonly state: JobState;
}

/** Everything a command touches: the store under test, the model, and the harness's own parts. */
export class World {
  readonly model = new QueueModel(LOCK_TTL_MS);
  /** Recurring jobs, for a store that has them. Empty unless a command upserted one. */
  readonly crons = new CronModel();
  readonly bells = new FaultyDoorbells();
  /** Store lease per model lease number. */
  readonly tokens = new Map<number, Lease>();
  /** Last state seen per id, for the transition check. */
  readonly observed = new Map<string, Observation>();
  /** First DLQ entry seen per `id#generation`, for the rewrite check. */
  readonly dlqSeen = new Map<string, DlqEntry>();
  /** Real workers that take the bells and end the leases, for a target that runs them. */
  bridge: WorkerBridge | null = null;

  constructor(
    readonly store: StateStore,
    readonly clock: VirtualClock,
    private readonly checks: ReadonlySet<CheckName>
  ) {}

  now(): number {
    return this.clock.now();
  }

  /** Fails the run if `check` is enabled for this target. */
  violate(check: CheckName, detail: string): void {
    if (this.checks.has(check)) throw new InvariantViolation(check, detail);
  }

  /**
   * A sweep interval passes before a tick, and the models take what the tick must: the leases that
   * expired are recovered, and the crons that are due fire once each.
   */
  sweep(): void {
    this.clock.advance(TICK_INTERVAL_MS);
    this.model.recoverExpired(this.now());
    this.crons.fire(this.now());
  }

  /**
   * What the SDK does with rings: ring those inside the transport's delay window (the fault is
   * applied to the publish), then report every bell the broker took to `markRung`. A dropped
   * bell was taken and then lost, which is the case the tick has to repair. A bell of a queue the
   * job model does not hold (a cron's) is taken and reported but never delivered: nothing claims it.
   */
  async ring(rings: readonly Ring[], fault: RingFault): Promise<void> {
    const due = rings.filter((ring) => ring.dueInMs <= MAX_DELIVER_DELAY_MS);
    if (due.length === 0) return;
    this.bells.ring(
      due.filter((ring) => MODELLED_QUEUES.has(ring.bell.queue)).map((ring) => ring.bell),
      fault
    );
    const rung = due.flatMap((ring) =>
      ring.bell.jobId === undefined
        ? []
        : [{ jobId: ring.bell.jobId, deliverAfterMs: ring.dueInMs }]
    );
    await this.store.markRung(rung);
  }

  token(lease: ModelLease): Lease {
    const token = this.tokens.get(lease.no);
    if (!token) throw new Error(`no store lease recorded for lease ${lease.no}`);
    return token;
  }
}

/** The job generation the harness stored in a job's data, or NaN if it is missing. */
export function generationOf(data: unknown): number {
  if (typeof data === 'object' && data !== null && 'generation' in data) {
    const value = (data as { generation: unknown }).generation;
    if (typeof value === 'number') return value;
  }
  return Number.NaN;
}
