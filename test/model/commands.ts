import fc from 'fast-check';
import type { CommandName, ModelCommand } from './command';
import { ConcurrentTicksCommand, UpsertCronCommand } from './commands-cron';
import type { LeaseOp } from './commands-jobs';
import { ClaimCommand, CompleteManyCommand, EnqueueCommand, LeaseCommand } from './commands-jobs';
import {
  AdvanceClockCommand,
  ConcurrencyLimitCommand,
  CrashCommand,
  DeliverLateCommand,
  ExpireLeaseCommand,
  OperatorCommand,
  PauseCommand,
  RateLimitCommand,
  RecoverCommand,
  TickCommand,
} from './commands-ops';
import { CRON_SLOTS } from './cronModel';
import { RING_FAULTS } from './transport';
import { CUSTOM_IDS, LOCK_TTL_MS, QUEUES, TICK_INTERVAL_MS, WORKERS } from './world';

const queue = fc.constantFrom(...QUEUES);
const worker = fc.constantFrom(...WORKERS);
/** Shrinks towards 'ok', so a minimised history keeps only the faults it needs. */
const fault = fc.constantFrom(...RING_FAULTS);
const pick = fc.nat({ max: 7 });
const priority = fc.integer({ min: 0, max: 3 });
const maxAttempts = fc.integer({ min: 1, max: 3 });
/** Two enqueues in five reuse a custom id, to exercise dedup, generations and retirement. */
const customId = fc.oneof(
  { arbitrary: fc.constant(null), weight: 3 },
  { arbitrary: fc.constantFrom(...CUSTOM_IDS), weight: 2 }
);

const job = (delayMs: fc.Arbitrary<number>) =>
  fc.record({ queue, priority, lifo: fc.boolean(), delayMs, maxAttempts, customId, fault });

/** Custom ids are FIFO only: their id does not follow creation order, which LIFO relies on. */
const enqueue = (name: 'enqueue' | 'enqueueDelayed', delayMs: fc.Arbitrary<number>) =>
  job(delayMs).map(
    (spec) =>
      new EnqueueCommand(
        name,
        { ...spec, lifo: spec.lifo && spec.customId === null },
        spec.customId,
        spec.fault
      )
  );

const leaseOp = (
  name: 'heartbeat' | 'release' | 'complete' | 'fail' | 'zombie',
  ops: readonly LeaseOp[]
) =>
  fc
    .tuple(fc.constantFrom(...ops), pick, fault)
    .map(([op, index, ring]) => new LeaseCommand(name, op, index, ring));

const operator = (name: 'promote' | 'changePriority' | 'cancel') =>
  fc
    .tuple(pick, priority, fault)
    .map(([index, value, ring]) => new OperatorCommand(name, index, value, ring));

/** Windows long enough to span a few commands, short enough that `advanceClock` rolls them over. */
const rateSpec = fc.record({
  max: fc.integer({ min: 1, max: 3 }),
  durationMs: fc.constantFrom(500, 1_000, TICK_INTERVAL_MS),
});

/** The lease operations a zombie may attempt, limited to those the target implements. */
const ZOMBIE_OPS = ['complete', 'fail', 'heartbeat', 'release'] as const;

const GENERATORS: Record<Exclude<CommandName, 'zombie'>, fc.Arbitrary<ModelCommand>> = {
  enqueue: enqueue('enqueue', fc.constant(0)),
  enqueueDelayed: enqueue('enqueueDelayed', fc.constantFrom(1, 5_000, LOCK_TTL_MS - 5_000)),
  claim: fc
    .tuple(worker, fc.integer({ min: 1, max: 2 }), pick)
    .map(([who, n, index]) => new ClaimCommand(who, n, index)),
  heartbeat: leaseOp('heartbeat', ['heartbeat']),
  release: leaseOp('release', ['release']),
  complete: leaseOp('complete', ['complete']),
  completeMany: fc
    .tuple(fc.array(pick, { minLength: 1, maxLength: 4 }), fc.option(pick, { nil: null, freq: 3 }))
    .map(([picks, stale]) => new CompleteManyCommand(picks, stale)),
  fail: leaseOp('fail', ['fail', 'fail-unrecoverable']),
  advanceClock: fc
    .constantFrom(1, 1_000, TICK_INTERVAL_MS + 1, LOCK_TTL_MS + 1)
    .map((ms) => new AdvanceClockCommand(ms)),
  expireLease: fc
    .tuple(pick, fc.constantFrom('at' as const, 'before' as const))
    .map(([index, edge]) => new ExpireLeaseCommand(index, edge)),
  pause: queue.map((name) => new PauseCommand('pause', name)),
  resume: queue.map((name) => new PauseCommand('resume', name)),
  setRateLimit: fc
    .tuple(queue, fc.option(rateSpec, { nil: null, freq: 4 }))
    .map(([name, spec]) => new RateLimitCommand(name, spec)),
  setConcurrencyLimit: fc
    .tuple(queue, fc.option(fc.integer({ min: 1, max: 3 }), { nil: null, freq: 4 }))
    .map(([name, max]) => new ConcurrencyLimitCommand(name, max)),
  promote: operator('promote'),
  changePriority: operator('changePriority'),
  cancel: operator('cancel'),
  tick: fc.constant(null).map(() => new TickCommand()),
  recover: fc.constant(null).map(() => new RecoverCommand()),
  crash: worker.map((who) => new CrashCommand(who)),
  deliverLate: fc.constant(null).map(() => new DeliverLateCommand()),
  upsertCron: fc
    .tuple(
      fc.constantFrom(...CRON_SLOTS),
      // Shorter than a sweep, equal to it, and longer: a short one misses occurrences between ticks.
      fc.constantFrom(1_000, 5_000, TICK_INTERVAL_MS, 25_000),
      fc.option(fc.integer({ min: 1, max: 3 }), { nil: null, freq: 3 }),
      fc.boolean()
    )
    .map(([slot, every, max, now]) => new UpsertCronCommand(slot, every, max, now)),
  concurrentTicks: fc.constant(null).map(() => new ConcurrentTicksCommand()),
};

/** How often each command is drawn, relative to 1. Jobs need producing and claiming to matter. */
const WEIGHTS: Partial<Record<CommandName, number>> = {
  enqueue: 3,
  claim: 4,
  complete: 2,
  upsertCron: 2,
};

export function commandArbitraries(
  enabled: ReadonlySet<CommandName>
): fc.Arbitrary<ModelCommand>[] {
  const zombieOps = ZOMBIE_OPS.filter((op) => enabled.has(op));
  return [...enabled].flatMap((name) => {
    const generator = name === 'zombie' ? zombie(zombieOps) : GENERATORS[name];
    return generator ? Array.from({ length: WEIGHTS[name] ?? 1 }, () => generator) : [];
  });
}

/** A used-up lease is tried with every operation the target has, so a store that lacks one is not asked. */
function zombie(ops: readonly LeaseOp[]): fc.Arbitrary<ModelCommand> | null {
  return ops.length === 0 ? null : leaseOp('zombie', ops);
}
