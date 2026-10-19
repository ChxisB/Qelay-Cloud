import type { CommandName } from './command';
import { ModelCommand } from './command';
import { verifyClaim, verifyOutcome } from './invariants';
import { allows, stateOf } from './model';
import type { JobSpec } from './reference';
import type { RingFault } from './transport';
import type { World } from './world';

/** Inserts one job, then rings for it if it is claimable now (the ring may be faulted). */
export class EnqueueCommand extends ModelCommand {
  constructor(
    readonly name: Extract<CommandName, 'enqueue' | 'enqueueDelayed'>,
    private readonly spec: JobSpec,
    private readonly customId: string | null,
    private readonly fault: RingFault
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const now = world.now();
    const plan = world.model.planEnqueue(this.customId);
    const [result] = await world.store.enqueue([
      {
        queue: this.spec.queue,
        data: { generation: plan.generation },
        options: {
          priority: this.spec.priority,
          lifo: this.spec.lifo,
          delay: this.spec.delayMs,
          attempts: this.spec.maxAttempts,
          backoff: 0,
          ...(this.customId === null ? {} : { jobId: this.customId }),
        },
      },
    ]);
    if (!result) {
      world.violate('MODEL.outcome', 'enqueue returned no job');
      return;
    }
    if (plan.live) {
      if (result.created || result.id !== plan.live.id) {
        world.violate('MODEL.outcome', `enqueue of live ${plan.live.id} did not deduplicate`);
      }
      return;
    }
    if (!result.created || (this.customId === null && world.model.jobs.has(result.id))) {
      world.violate('MODEL.outcome', `enqueue reused ${result.id} instead of creating a job`);
      return;
    }
    const job = world.model.add(result.id, this.customId !== null, this.spec, plan.generation, now);
    if (result.state !== stateOf(job, now)) {
      world.violate(
        'MODEL.state',
        `${job.id} enqueued as ${result.state}, not ${stateOf(job, now)}`
      );
    }
    const claimable = allows('claim', stateOf(job, now));
    if (claimable && result.ring?.dueInMs !== 0) {
      world.violate('MODEL.outcome', `${job.id} is claimable but enqueue returned no ring for it`);
    }
    await world.ring(result.ring ? [result.ring] : [], this.fault);
  }

  toString(): string {
    const { queue, priority, lifo, delayMs, maxAttempts } = this.spec;
    const id = this.customId === null ? '' : ` id=${this.customId}`;
    const delay = delayMs > 0 ? ` +${delayMs}ms` : '';
    return `${this.name}(${queue} p${priority}${lifo ? ' lifo' : ''} max${maxAttempts}${delay}${id} ring=${this.fault})`;
  }
}

/** A worker takes one pending doorbell, then claims up to `n` jobs from its queue. */
export class ClaimCommand extends ModelCommand {
  readonly name = 'claim';

  constructor(
    private readonly worker: string,
    private readonly n: number,
    private readonly pick: number
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const bell = world.bells.take(this.pick);
    if (!bell) return;
    if (world.bridge) {
      // A real worker takes the bell; its claim reaches the model through the bridge's store.
      await world.bridge.deliver(this.worker, bell);
      return;
    }
    const now = world.now();
    // A claim restarts a rate window that has run out, even when it takes nothing.
    world.model.limits.refresh(bell.queue, now);
    const claimed = await world.store.claim(bell.queue, this.worker, this.n);
    for (const { item, job } of verifyClaim(world, bell.queue, this.n, claimed)) {
      const lease = world.model.claim(job, this.worker, now);
      world.tokens.set(lease.no, item.lease);
    }
  }

  toString(): string {
    return `claim(${this.worker} n${this.n} bell#${this.pick})`;
  }
}

export type LeaseOp = 'heartbeat' | 'release' | 'complete' | 'fail' | 'fail-unrecoverable';

/**
 * A worker uses one of its leases. As `zombie`, a lease nobody should hold any more is used
 * instead: a crashed worker's, or one already finished or refused. It must be rejected unless
 * it is still current, which a crashed worker's unexpired lease is.
 */
export class LeaseCommand extends ModelCommand {
  constructor(
    readonly name: Extract<CommandName, 'heartbeat' | 'release' | 'complete' | 'fail' | 'zombie'>,
    private readonly op: LeaseOp,
    private readonly pick: number,
    private readonly fault: RingFault
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const leases = this.name === 'zombie' ? world.model.spent : world.model.held;
    const lease = leases[this.pick % Math.max(leases.length, 1)];
    if (!lease) return;
    const now = world.now();
    const current = world.model.isCurrent(lease, now);
    const token = world.token(lease);
    const what = `${this.op} of ${lease.jobId} by ${lease.worker} (lease ${lease.no})`;
    if (this.op === 'heartbeat') {
      const ok = await world.store.heartbeat(token);
      verifyOutcome(world, what, ok, current, true);
      if (!ok) world.model.release(lease);
      else if (current) world.model.renew(lease, now);
      return;
    }
    if (this.op === 'release') {
      const outcome = await world.store.release(token);
      verifyOutcome(world, what, outcome.ok, current, true);
      if (outcome.ok && current) {
        world.model.giveBack(lease, now);
        if (!outcome.rings.some((ring) => ring.bell.jobId === lease.jobId && ring.dueInMs === 0)) {
          world.violate('MODEL.outcome', `${what} returned no ring for the job it gave back`);
        }
      }
      world.model.release(lease);
      await world.ring(outcome.rings, this.fault);
      return;
    }
    // With real workers the worker makes the write, and the rings after it.
    const finished =
      this.name === 'zombie' ? null : await world.bridge?.finish(lease, this.op, this.fault);
    const outcome =
      finished ??
      (this.op === 'complete'
        ? await world.store.complete(token, { lease: lease.no })
        : await world.store.fail(token, {
            message: 'model failure',
            unrecoverable: this.op === 'fail-unrecoverable',
          }));
    verifyOutcome(world, what, outcome.ok, current, true);
    if (outcome.ok && current) {
      if (this.op === 'complete') world.model.complete(lease, now);
      else world.model.fail(lease, this.op === 'fail-unrecoverable', now);
    }
    world.model.release(lease);
    if (!finished) await world.ring(outcome.rings, this.fault);
  }

  toString(): string {
    const ring = this.op === 'heartbeat' || this.op === 'complete' ? '' : ` ring=${this.fault}`;
    return `${this.name}(${this.op} lease#${this.pick}${ring})`;
  }
}

/**
 * Several held leases (and, sometimes, one nobody should hold any more) finish in one
 * `completeMany`. Each is judged as a single `complete` of it would be: done when current, refused otherwise.
 */
export class CompleteManyCommand extends ModelCommand {
  readonly name = 'completeMany' as const;

  constructor(
    private readonly picks: readonly number[],
    private readonly stale: number | null
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const { held, spent } = world.model;
    const leases = new Set(
      this.picks.flatMap((pick) => (held.length > 0 ? [held[pick % held.length]!] : []))
    );
    if (this.stale !== null && spent.length > 0) leases.add(spent[this.stale % spent.length]!);
    if (leases.size === 0) return;
    const batch = [...leases];
    const now = world.now();
    const current = batch.map((lease) => world.model.isCurrent(lease, now));
    const outcomes = await world.store.completeMany(
      batch.map((lease) => ({ lease: world.token(lease), result: { lease: lease.no } }))
    );
    batch.forEach((lease, index) => {
      const outcome = outcomes[index];
      if (outcome === undefined || outcome instanceof Error) {
        return world.violate(
          'MODEL.outcome',
          `completeMany of ${lease.jobId} returned ${String(outcome)}`
        );
      }
      const what = `completeMany of ${lease.jobId} by ${lease.worker} (lease ${lease.no})`;
      verifyOutcome(world, what, outcome.ok, current[index]!, true);
      if (outcome.ok && current[index]) world.model.complete(lease, now);
      world.model.release(lease);
    });
  }

  toString(): string {
    return `completeMany(leases#${this.picks.join(',')}${this.stale === null ? '' : ` zombie#${this.stale}`})`;
  }
}
