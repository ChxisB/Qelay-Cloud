import type { Ring } from '@qelay-cloud/core';
import type { CommandName } from './command';
import { ModelCommand } from './command';
import { verifyNothingStuck, verifyOutcome } from './invariants';
import type { RateSpec } from './limits';
import { allows, stateOf } from './model';
import type { RingFault } from './transport';
import type { World } from './world';
import { TICK_BUDGET } from './world';

export class AdvanceClockCommand extends ModelCommand {
  readonly name = 'advanceClock';

  constructor(private readonly ms: number) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    world.clock.advance(this.ms);
  }

  toString(): string {
    return `advanceClock(${this.ms}ms)`;
  }
}

/** Jumps the clock to the edge of an active job's lease: at expiry, or 1 ms before it. */
export class ExpireLeaseCommand extends ModelCommand {
  readonly name = 'expireLease';

  constructor(
    private readonly pick: number,
    private readonly edge: 'at' | 'before'
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const active = [...world.model.jobs.values()]
      .filter((job) => job.phase === 'active')
      .sort((a, b) => a.seq - b.seq);
    const job = active[this.pick % Math.max(active.length, 1)];
    if (!job) return;
    world.clock.advanceTo(this.edge === 'at' ? job.leaseUntil : job.leaseUntil - 1);
  }

  toString(): string {
    return `expireLease(active#${this.pick} ${this.edge})`;
  }
}

export class PauseCommand extends ModelCommand {
  constructor(
    readonly name: Extract<CommandName, 'pause' | 'resume'>,
    private readonly queue: string
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    if (this.name === 'pause') {
      await world.store.pause(this.queue);
      world.model.paused.add(this.queue);
    } else {
      await world.store.resume(this.queue);
      world.model.paused.delete(this.queue);
    }
  }

  toString(): string {
    return `${this.name}(${this.queue})`;
  }
}

/** Sets or removes a queue's rate limit; a claim must then honour the window. */
export class RateLimitCommand extends ModelCommand {
  readonly name = 'setRateLimit';

  constructor(
    private readonly queue: string,
    private readonly spec: RateSpec | null
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    await world.store.setRateLimit(this.queue, this.spec);
    world.model.limits.setRate(this.queue, this.spec, world.now());
  }

  toString(): string {
    const { spec } = this;
    return `setRateLimit(${this.queue} ${spec ? `${spec.max}/${spec.durationMs}ms` : 'none'})`;
  }
}

/** Sets or removes how many jobs of a queue may be active at once. */
export class ConcurrencyLimitCommand extends ModelCommand {
  readonly name = 'setConcurrencyLimit';

  constructor(
    private readonly queue: string,
    private readonly max: number | null
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    await world.store.setConcurrencyLimit(this.queue, this.max);
    world.model.limits.setConcurrency(this.queue, this.max);
  }

  toString(): string {
    return `setConcurrencyLimit(${this.queue} ${this.max ?? 'none'})`;
  }
}

/**
 * An operator action on any id the store has answered for, live, finished or cancelled. It
 * must succeed exactly when the transition table allows it from the job's current state.
 */
export class OperatorCommand extends ModelCommand {
  constructor(
    readonly name: Extract<CommandName, 'promote' | 'changePriority' | 'cancel'>,
    private readonly pick: number,
    private readonly priority: number,
    private readonly fault: RingFault
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const ids = world.model.knownIds();
    const id = ids[this.pick % Math.max(ids.length, 1)];
    if (id === undefined) return;
    const job = world.model.jobs.get(id);
    const now = world.now();
    const state = job ? stateOf(job, now) : null;
    if (this.name === 'promote') {
      const expected = state !== null && allows('promote', state);
      const outcome = await world.store.promote(id);
      verifyOutcome(world, `promote ${id} (${state})`, outcome.ok, expected, false);
      if (outcome.ok && expected && job) world.model.promote(job, now);
      await world.ring(outcome.rings, this.fault);
    } else if (this.name === 'changePriority') {
      const expected = state !== null && allows('change-priority', state);
      const ok = await world.store.changePriority(id, this.priority);
      verifyOutcome(world, `changePriority ${id} (${state})`, ok, expected, false);
      if (ok && expected && job) world.model.changePriority(job, this.priority, now);
    } else {
      const expected = state !== null && allows('cancel', state);
      const ok = await world.store.cancel(id);
      verifyOutcome(world, `cancel ${id} (${state})`, ok, expected, false);
      if (ok && expected && job) world.model.cancel(job, now);
    }
  }

  toString(): string {
    const detail =
      this.name === 'changePriority'
        ? ` p${this.priority}`
        : this.name === 'promote'
          ? ` ring=${this.fault}`
          : '';
    return `${this.name}(job#${this.pick}${detail})`;
  }
}

/**
 * One sweep interval passes, then the maintenance tick runs: lease recovery, then re-rings.
 * Tick rings are not faulted (the tick retries its own publishes). Then I3 must hold.
 */
export class TickCommand extends ModelCommand {
  readonly name = 'tick';

  protected async apply(world: World): Promise<void> {
    world.sweep();
    const report = await world.store.tick(TICK_BUDGET);
    await world.ring(report.rings, 'ok');
  }

  protected override after(world: World): void {
    verifyNothingStuck(world);
  }

  toString(): string {
    return 'tick()';
  }
}

/** What `recover` needs of a store: the Postgres store has it as a method of its own, apart from the tick that calls it. */
interface RecoveringStore {
  recoverExpired(
    limit?: number
  ): Promise<{ rings: readonly Ring[]; recovered: number; more: boolean }>;
}

/**
 * Lease recovery without the rest of the tick: the model recovers every active job whose lease has
 * expired, and the store's recovery must retry or fail exactly those jobs, counting an attempt each.
 * A store without `recoverExpired` (the fake ones recover in their tick) does nothing.
 */
export class RecoverCommand extends ModelCommand {
  readonly name = 'recover';

  protected async apply(world: World): Promise<void> {
    const store = world.store as Partial<RecoveringStore>;
    if (typeof store.recoverExpired !== 'function') return;
    const expected = world.model.recoverExpired(world.now()).length;
    let recovered = 0;
    for (let more = true; more;) {
      const report = await store.recoverExpired(10);
      recovered += report.recovered;
      await world.ring(report.rings, 'ok');
      more = report.more;
    }
    if (recovered !== expected) {
      world.violate(
        'MODEL.outcome',
        `recovery took ${recovered} jobs, the model expected ${expected}`
      );
    }
  }

  toString(): string {
    return 'recover()';
  }
}

/** A worker dies without telling the store. Its leases expire and the tick recovers them. */
export class CrashCommand extends ModelCommand {
  readonly name = 'crash';

  constructor(private readonly worker: string) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    world.model.crash(this.worker);
  }

  toString(): string {
    return `crash(${this.worker})`;
  }
}

/** Every late doorbell arrives now. */
export class DeliverLateCommand extends ModelCommand {
  readonly name = 'deliverLate';

  protected async apply(world: World): Promise<void> {
    world.bells.flushLate();
  }

  toString(): string {
    return 'deliverLate()';
  }
}
