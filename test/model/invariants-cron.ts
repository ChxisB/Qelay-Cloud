import type { StateCounts } from '@qelay-cloud/core';
import type { World } from './world';

/** What the harness needs of a store with recurring jobs: the Postgres store's `crons` facet. */
export interface CronCapable {
  readonly crons: {
    upsert(spec: {
      readonly name: string;
      readonly queue: string;
      readonly jobName: string;
      readonly data: unknown;
      readonly repeatEvery: number;
      readonly preventOverlap: false;
      readonly immediately: boolean;
      readonly maxLimit?: number;
    }): Promise<CronState>;
    get(name: string): Promise<CronState | null>;
  };
}

export interface CronState {
  readonly nextRun: number;
  readonly executions: number;
  readonly maxLimit: number | null;
}

/** The cron facet of a store, or null for one that has none (the fake stores). */
export function cronsOf(world: World): CronCapable['crons'] | null {
  return (world.store as Partial<CronCapable>).crons ?? null;
}

const total = (counts: StateCounts): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * Every cron the model holds is in the store with the executions and next run the model expects, and
 * its queue holds one job per execution: no occurrence made two jobs, none made none.
 */
export async function verifyCrons(world: World): Promise<void> {
  const crons = cronsOf(world);
  if (!crons) return;
  for (const cron of world.crons.crons.values()) {
    const record = await crons.get(cron.name);
    if (!record) {
      world.violate('CRON.exactlyOnce', `${cron.name} is in the model but not in the store`);
      continue;
    }
    if (record.executions !== cron.executions || record.nextRun !== cron.nextRun) {
      world.violate(
        'CRON.exactlyOnce',
        `${cron.name} has ${record.executions} executions, next run ${record.nextRun}; ` +
          `the model expects ${cron.executions}, next run ${cron.nextRun} (now ${world.now()})`
      );
    }
    if (record.maxLimit !== cron.maxLimit) {
      world.violate(
        'CRON.exactlyOnce',
        `${cron.name} has limit ${record.maxLimit}, the model expects ${cron.maxLimit}`
      );
    }
    const jobs = total(await world.store.counts(cron.name));
    if (jobs !== cron.executions) {
      world.violate(
        'CRON.exactlyOnce',
        `${cron.name} made ${jobs} jobs for ${cron.executions} executions (now ${world.now()})`
      );
    }
  }
}
