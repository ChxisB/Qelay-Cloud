import type { Ring } from '@qelay-cloud/core';
import type { AsyncCommand } from 'fast-check';
import { verifyFlows } from './invariants';
import type { Change, FlowModel, ModelNode } from './reference';
import { FlowWorld } from './world';

/**
 * One step of a history. Every command is always applicable: one whose target does not exist (no
 * active job, no flow) does nothing, so histories shrink freely. After each command the whole store
 * is checked against the model.
 */
export abstract class FlowCommand implements AsyncCommand<FlowModel, FlowWorld> {
  check(): boolean {
    return true;
  }

  async run(_model: FlowModel, world: FlowWorld): Promise<void> {
    await this.apply(world);
    await verifyFlows(world);
    await this.after?.(world);
  }

  protected abstract apply(world: FlowWorld): Promise<void>;

  /** Checks that only make sense after this command, once the store matches the model. */
  protected after?(world: FlowWorld): Promise<void>;

  abstract toString(): string;
}

/** Picks an item the way every command does: any integer selects one, and an empty list selects none. */
export const choose = <T>(items: readonly T[], pick: number): T | undefined =>
  items.length === 0 ? undefined : items[pick % items.length];

/** Every job the harness ever made, by id, for the commands that act on any of them. */
export const everyJob = (world: FlowWorld): ModelNode[] =>
  [...world.model.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

/** The active jobs whose lease is still current: the ones a worker may complete or fail. */
export const working = (world: FlowWorld): ModelNode[] =>
  world.model.inPhase('active').filter((node) => node.leaseUntil > world.now());

/** The message a worker fails a job with. */
export const boom = (id: string): string => `boom ${id}`;

export const FAILED = (id: string, error: string): Change => ({ id, outcome: 'failed', error });
export const COMPLETED = (id: string): Change => ({ id, outcome: 'completed', error: '' });

/** The bells of an operation are those of the parents it released, each once. */
export function verifyReleased(
  world: FlowWorld,
  what: string,
  rings: readonly Ring[],
  released: readonly string[]
): void {
  const rung = FlowWorld.rungIds(rings);
  const expected = [...released].sort();
  if (rung.join() !== expected.join()) {
    world.violate('F7.rings', `${what} rang [${rung}], the parents it released are [${expected}]`);
  }
}
