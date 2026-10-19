import type { AsyncCommand } from 'fast-check';
import { verifyWorld } from './invariants';
import type { QueueModel } from './reference';
import type { World } from './world';

export const COMMAND_NAMES = [
  'enqueue',
  'enqueueDelayed',
  'claim',
  'heartbeat',
  'release',
  'complete',
  'completeMany',
  'fail',
  'zombie',
  'advanceClock',
  'expireLease',
  'pause',
  'resume',
  'setRateLimit',
  'setConcurrencyLimit',
  'promote',
  'changePriority',
  'cancel',
  'tick',
  'recover',
  'crash',
  'deliverLate',
  'upsertCron',
  'concurrentTicks',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * One step of a history. Every command is always applicable: a command whose target does not
 * exist (no doorbell, no lease, no job) does nothing, so histories shrink freely. After each
 * command the whole store is checked against the model.
 */
export abstract class ModelCommand implements AsyncCommand<QueueModel, World> {
  abstract readonly name: CommandName;

  check(): boolean {
    return true;
  }

  async run(_model: QueueModel, world: World): Promise<void> {
    await this.apply(world);
    await verifyWorld(world);
    this.after?.(world);
  }

  protected abstract apply(world: World): Promise<void>;

  /** Checks that only make sense after this command, once the store matches the model. */
  protected after?(world: World): void;

  abstract toString(): string;
}
