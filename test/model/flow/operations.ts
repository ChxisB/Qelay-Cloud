import { TICK_BUDGET } from '../world';
import { FlowCommand, FAILED, choose, everyJob, verifyReleased } from './command';
import { verifyAllRung } from './invariants';
import { FlowWorld, LEASE_MS, TICK_MS } from './world';

/** Time passes. Leases run out; nothing else happens until something looks. */
export class AdvanceClock extends FlowCommand {
  constructor(private readonly ms: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    world.clock.advance(this.ms);
  }

  toString(): string {
    return `advanceClock(${this.ms}ms)`;
  }
}

/** Every active job whose lease ran out ends, as the recovery ends it: failed, with no attempt left. */
function expire(world: FlowWorld): { ids: string[]; released: string[] } {
  const expired = world.model.expired(world.now());
  const ids = expired.map((node) => node.id);
  const released = world.model.finish(ids.map((id) => FAILED(id, 'Job lease expired')));
  return { ids, released };
}

/** The lease recovery on its own. */
export class Recover extends FlowCommand {
  protected async apply(world: FlowWorld): Promise<void> {
    const { ids, released } = expire(world);
    const rings = [];
    let recovered = 0;
    for (let more = true; more;) {
      const report = await world.store.recoverExpired(1000);
      recovered += report.recovered;
      rings.push(...report.rings);
      more = report.more;
    }
    if (recovered !== ids.length) {
      world.violate('F8.outcome', `recovery took ${recovered} jobs, the model expected [${ids}]`);
    }
    verifyReleased(world, 'recovery', rings, released);
    await world.ring(rings);
    for (const id of ids) world.retire(id);
    await world.planted?.afterEnd?.(world);
  }

  toString(): string {
    return 'recover()';
  }
}

/** The workers of every active job vanish: their leases run out together and the recovery takes them in one batch. */
export class Outage extends Recover {
  protected override async apply(world: FlowWorld): Promise<void> {
    world.clock.advance(LEASE_MS);
    await super.apply(world);
  }

  override toString(): string {
    return 'outage()';
  }
}

/**
 * A sweep interval passes and the maintenance tick runs: it recovers the leases that ran out, then
 * rings what is claimable and not rung. It rings nothing that is not claimable, and leaves nothing
 * claimable unrung, however the bells of the commands before it were dropped.
 */
export class Tick extends FlowCommand {
  protected async apply(world: FlowWorld): Promise<void> {
    world.clock.advance(TICK_MS);
    const { ids } = expire(world);
    const report = await world.store.tick(TICK_BUDGET);
    if (report.recovered !== ids.length) {
      world.violate(
        'F8.outcome',
        `the tick recovered ${report.recovered} jobs, the model expected [${ids}]`
      );
    }
    for (const id of FlowWorld.rungIds(report.rings)) {
      if (world.model.nodes.get(id)?.phase !== 'ready') {
        world.violate(
          'F9.tick',
          `the tick rang ${id}, which is ${world.model.nodes.get(id)?.phase ?? 'unknown'}`
        );
      }
    }
    await world.ring(report.rings);
    for (const id of ids) world.retire(id);
    await world.planted?.afterEnd?.(world);
  }

  protected override async after(world: FlowWorld): Promise<void> {
    await verifyAllRung(world);
  }

  toString(): string {
    return 'tick()';
  }
}

/** The operator cancels a job: a claimable job or a parent goes, a child's parent stops awaiting it. */
export class Cancel extends FlowCommand {
  constructor(private readonly pick: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const node = choose(everyJob(world), this.pick);
    if (!node) return;
    const expected = world.model.cancel(node.id).ok;
    const ok = await world.store.cancel(node.id);
    if (ok !== expected) {
      world.violate(
        'F8.outcome',
        `cancel of ${node.id} answered ${ok}, the model says ${expected}`
      );
    }
  }

  toString(): string {
    return `cancel(job#${this.pick})`;
  }
}

/** The operator removes a job: refused while a live parent holds an edge to it or while it runs. */
export class Remove extends FlowCommand {
  constructor(private readonly pick: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const node = choose(everyJob(world), this.pick);
    if (!node) return;
    const expected = world.model.remove(node.id);
    const actual = await world.store.control.remove(node.id);
    if (actual !== expected) {
      world.violate(
        'F8.outcome',
        `remove of ${node.id} answered ${actual}, the model says ${expected}`
      );
    }
  }

  toString(): string {
    return `remove(job#${this.pick})`;
  }
}

/** Promoting a job that is not delayed does nothing: no flow job has a delay. */
export class Promote extends FlowCommand {
  constructor(private readonly pick: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const node = choose(everyJob(world), this.pick);
    if (!node) return;
    const outcome = await world.store.promote(node.id);
    if (outcome.ok || outcome.rings.length > 0) {
      world.violate('F8.outcome', `promote of ${node.id} (${node.phase}) was accepted`);
    }
  }

  toString(): string {
    return `promote(job#${this.pick})`;
  }
}

/** A priority changes only on a claimable job, and never lets a parent that waits be claimed. */
export class ChangePriority extends FlowCommand {
  constructor(
    private readonly pick: number,
    private readonly priority: number
  ) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const node = choose(everyJob(world), this.pick);
    if (!node) return;
    const ok = await world.store.changePriority(node.id, this.priority);
    if (ok !== (node.phase === 'ready')) {
      world.violate('F8.outcome', `changePriority of ${node.id} (${node.phase}) answered ${ok}`);
    }
  }

  toString(): string {
    return `changePriority(job#${this.pick} p${this.priority})`;
  }
}
