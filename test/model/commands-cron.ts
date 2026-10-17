import { ModelCommand } from './command';
import type { CronSlot } from './cronModel';
import { verifyNothingStuck } from './invariants';
import { cronsOf } from './invariants-cron';
import type { World } from './world';
import { TICK_BUDGET } from './world';

/** Ticks that run at the same moment in `concurrentTicks`: enough that two always contend. */
export const CONCURRENT_TICKS = 4;

/**
 * Creates a fixed-interval cron, or replaces the definition of the one in its slot. The store's
 * answer must be the model's: a new cron is due an interval from now (or now), a replaced one keeps
 * its executions and, unless the interval changed, its next run. Needs a store with crons.
 */
export class UpsertCronCommand extends ModelCommand {
  readonly name = 'upsertCron';

  constructor(
    private readonly slot: CronSlot,
    private readonly intervalMs: number,
    private readonly maxLimit: number | null,
    private readonly immediately: boolean
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const crons = cronsOf(world);
    if (!crons) return;
    const expected = world.crons.upsert(
      this.slot,
      this.intervalMs,
      this.maxLimit,
      this.immediately,
      world.now()
    );
    const record = await crons.upsert({
      name: this.slot,
      queue: this.slot,
      jobName: 'occurrence',
      data: { slot: this.slot },
      repeatEvery: this.intervalMs,
      preventOverlap: false,
      immediately: this.immediately,
      ...(this.maxLimit === null ? {} : { maxLimit: this.maxLimit }),
    });
    if (
      record.nextRun !== expected.nextRun ||
      record.executions !== expected.executions ||
      record.maxLimit !== expected.maxLimit
    ) {
      world.violate(
        'CRON.exactlyOnce',
        `upsert of ${this.slot} returned next run ${record.nextRun}, ${record.executions} executions, ` +
          `limit ${record.maxLimit}; the model expects ${expected.nextRun}, ${expected.executions}, ` +
          `${expected.maxLimit}`
      );
    }
  }

  toString(): string {
    const limit = this.maxLimit === null ? '' : ` max${this.maxLimit}`;
    return `upsertCron(${this.slot} every ${this.intervalMs}ms${limit}${this.immediately ? ' immediately' : ''})`;
  }
}

/**
 * One sweep interval passes, then several ticks run at once, as the instances of a deployed service
 * do. Each due occurrence of each cron must make exactly one job in all of them together (checked
 * against the model after every command), and the doorbells the ticks hand back must leave nothing
 * stuck. Needs a store whose `tick` is safe to run concurrently.
 */
export class ConcurrentTicksCommand extends ModelCommand {
  readonly name = 'concurrentTicks';

  protected async apply(world: World): Promise<void> {
    world.sweep();
    const reports = await Promise.all(
      Array.from({ length: CONCURRENT_TICKS }, () => world.store.tick(TICK_BUDGET))
    );
    for (const report of reports) await world.ring(report.rings, 'ok');
  }

  protected override after(world: World): void {
    verifyNothingStuck(world);
  }

  toString(): string {
    return `concurrentTicks(${CONCURRENT_TICKS})`;
  }
}
