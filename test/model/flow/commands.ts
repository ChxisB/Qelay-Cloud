import { flattenFlow } from '@qelay-cloud/core';
import { FlowCommand, boom, choose, COMPLETED, FAILED, verifyReleased, working } from './command';
import type { NodeSpec } from './spec';
import { materialize } from './spec';
import type { FlowWorld } from './world';

/** A flow's shape, for a history that reads: `qa(qb!fail, qc)`. */
const shape = (spec: NodeSpec): string => {
  const mode = spec.mode === null ? '' : `!${spec.mode}`;
  const inner = spec.children.map(shape).join(', ');
  return `${spec.queue}${mode}${inner === '' ? '' : `(${inner})`}`;
};

/** Whether the bells of an add reach the transport. A dropped bell is for the tick to find. */
export type BellFate = 'rung' | 'dropped';

/** A flow is added: one transaction, the parents waiting, only the claimable jobs rung. */
export class AddFlow extends FlowCommand {
  constructor(
    private readonly spec: NodeSpec,
    private readonly fate: BellFate
  ) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const { model } = world;
    const { tree, ids } = materialize(this.spec, model.added + 1);
    model.add(this.spec);
    const added = await world.store.flows.add(flattenFlow(tree));
    if (!added.created) world.violate('F8.outcome', `a new flow ${ids[0]} was taken for a replay`);
    if (added.jobs.map((job) => job.id).join() !== ids.join()) {
      world.violate(
        'F8.outcome',
        `the jobs came back as [${added.jobs.map((job) => job.id)}], not [${ids}]`
      );
    }
    for (const job of added.jobs) {
      const waits = model.node(job.id).phase === 'waiting-children';
      if (waits !== (job.state === 'waiting-children')) {
        world.violate(
          'F1.state',
          `${job.id} was added ${job.state}, the model has ${model.node(job.id).phase}`
        );
      }
    }
    const rings = added.jobs.flatMap((job) => (job.ring ? [job.ring] : []));
    const rung = world.planted?.rings?.(rings, ids) ?? rings;
    verifyReleased(
      world,
      `adding ${ids[0]}`,
      rung,
      ids.filter((id) => model.node(id).phase === 'ready')
    );
    if (this.fate === 'rung') await world.ring(rung);
    await world.planted?.afterAdd?.(world, ids);
  }

  toString(): string {
    return `addFlow(${shape(this.spec)} bells ${this.fate})`;
  }
}

/** A flow already added is sent again, as a client that did not hear the answer would: nothing changes. */
export class ReplayFlow extends FlowCommand {
  constructor(private readonly pick: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const live = world.model.flows.filter((flow) =>
      ['ready', 'waiting-children', 'active'].includes(world.model.node(flow.root).phase)
    );
    const flow = choose(live, this.pick);
    if (!flow) return;
    const again = await world.store.flows.add(flattenFlow(materialize(flow.spec, flow.no).tree));
    if (again.created || again.root.id !== flow.root) {
      world.violate('F8.outcome', `a replay of ${flow.root} did not answer with the live flow`);
    }
  }

  toString(): string {
    return `replayFlow(#${this.pick})`;
  }
}

/** A worker claims up to `n` jobs of a queue at once. */
export class Claim extends FlowCommand {
  constructor(
    private readonly queue: string,
    private readonly worker: string,
    private readonly n: number
  ) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const { model } = world;
    const ready = model.inPhase('ready', this.queue);
    const claimed = await world.store.claim(this.queue, this.worker, this.n);
    if (claimed.length < Math.min(this.n, ready.length)) {
      world.violate(
        'F8.outcome',
        `${this.queue} has ${ready.length} ready jobs and ${claimed.length} of ${this.n} were claimed`
      );
    }
    for (const job of claimed) {
      const node = model.nodes.get(job.id);
      if (!node) world.violate('F1.state', `claimed ${job.id}, which no flow made`);
      if (node.claims > 0) world.violate('F5.atMostOnce', `${job.id} was claimed a second time`);
      const released = [...node.recorded.values()].some((entry) => entry.mode === 'continue');
      const unfinished = [...node.edges].filter((child) => model.node(child).phase !== 'completed');
      if (node.phase === 'waiting-children' || (unfinished.length > 0 && !released)) {
        world.violate('F4.parentOrder', `${job.id} was claimed while it awaits [${unfinished}]`);
      }
      if (node.phase !== 'ready' || node.queue !== this.queue) {
        world.violate(
          'F8.outcome',
          `claimed ${job.id}, which is ${node.phase} in ${node.queue} in the model`
        );
      }
      model.claim(job.id, job.leaseUntil);
      world.leases.set(job.id, job.lease);
    }
  }

  toString(): string {
    return `claim(${this.queue} ${this.worker} n${this.n})`;
  }
}

/** A worker ends a job it holds: completes it, or fails it for good (a flow job has one attempt). */
export class End extends FlowCommand {
  constructor(
    private readonly how: 'complete' | 'fail',
    private readonly pick: number
  ) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const node = choose(working(world), this.pick);
    if (!node) return;
    const lease = world.leases.get(node.id)!;
    const outcome =
      this.how === 'complete'
        ? await world.store.complete(lease, node.id)
        : await world.store.fail(lease, { message: boom(node.id), unrecoverable: false });
    if (!outcome.ok)
      world.violate(
        'F8.outcome',
        `${this.how} of ${node.id} was refused while its lease is current`
      );
    const released = world.model.finish([
      this.how === 'complete' ? COMPLETED(node.id) : FAILED(node.id, boom(node.id)),
    ]);
    verifyReleased(world, `${this.how} of ${node.id}`, outcome.rings, released);
    await world.ring(outcome.rings);
    world.retire(node.id);
    await world.planted?.afterEnd?.(world);
  }

  toString(): string {
    return `${this.how}(active#${this.pick})`;
  }
}

/**
 * Two workers complete two jobs at the same moment. Whatever order the store takes them in, a parent
 * whose last two children these were is released once and rung once.
 */
export class CompleteTogether extends FlowCommand {
  constructor(
    private readonly first: number,
    private readonly second: number
  ) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const active = working(world);
    const a = choose(active, this.first);
    const b = choose(
      active.filter((node) => node !== a),
      this.second
    );
    if (!a || !b) return;
    const [one, two] = await Promise.all(
      [a, b].map((node) => world.store.complete(world.leases.get(node.id)!, node.id))
    );
    if (!one!.ok || !two!.ok)
      world.violate('F8.outcome', `completing ${a.id} and ${b.id} together refused one`);
    const released = [
      ...world.model.finish([COMPLETED(a.id)]),
      ...world.model.finish([COMPLETED(b.id)]),
    ];
    verifyReleased(
      world,
      `completing ${a.id} and ${b.id} together`,
      [...one!.rings, ...two!.rings],
      released
    );
    await world.ring([...one!.rings, ...two!.rings]);
    world.retire(a.id);
    world.retire(b.id);
    await world.planted?.afterEnd?.(world);
  }

  toString(): string {
    return `completeTogether(active#${this.first}, active#${this.second})`;
  }
}

/** A worker whose lease was recovered, or whose job it already ended, comes back and is refused. */
export class Zombie extends FlowCommand {
  constructor(private readonly pick: number) {
    super();
  }

  protected async apply(world: FlowWorld): Promise<void> {
    const spent = choose(world.stale, this.pick);
    if (!spent) return;
    const outcome = await world.store.complete(spent.lease, 'too late');
    if (outcome.ok || outcome.rings.length > 0) {
      world.violate('F5.atMostOnce', `the spent lease of ${spent.id} was accepted again`);
    }
  }

  toString(): string {
    return `zombie(spent#${this.pick})`;
  }
}
