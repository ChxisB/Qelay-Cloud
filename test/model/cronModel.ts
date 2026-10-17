/**
 * The reference model of recurring jobs, for a store that has them (the Postgres store; the core
 * `StateStore` has no cron methods). Each cron is a fixed-interval one with `preventOverlap` off, so
 * every occurrence that is taken creates exactly one job, and it spawns into a queue of its own,
 * outside `QUEUES`: the job model never sees those jobs, and nothing claims them.
 *
 * The model states the rule the store must keep, not a second copy of its code: an occurrence that
 * is due is taken once however many ticks run at the same moment, one that was missed is not made up,
 * and a cron at its limit stops.
 */
export const CRON_SLOTS = ['cron-a', 'cron-b'] as const;
export type CronSlot = (typeof CRON_SLOTS)[number];

export interface ModelCron {
  readonly name: string;
  readonly intervalMs: number;
  readonly maxLimit: number | null;
  /** When the next occurrence is due. */
  nextRun: number;
  /** Occurrences taken so far: one job each. */
  executions: number;
}

export class CronModel {
  readonly crons = new Map<string, ModelCron>();

  /**
   * Creates the cron, or replaces its definition. A new cron is first due one interval from now (or
   * now, with `immediately`). A replaced one keeps its executions, and keeps its next run too unless
   * the interval changed.
   */
  upsert(
    name: string,
    intervalMs: number,
    maxLimit: number | null,
    immediately: boolean,
    now: number
  ): ModelCron {
    const before = this.crons.get(name);
    let nextRun = now + intervalMs;
    if (before?.intervalMs === intervalMs) nextRun = before.nextRun;
    else if (!before && immediately) nextRun = now;
    const cron: ModelCron = {
      name,
      intervalMs,
      maxLimit,
      nextRun,
      executions: before?.executions ?? 0,
    };
    this.crons.set(name, cron);
    return cron;
  }

  /**
   * A tick runs at `now`: every cron that is due and under its limit takes one occurrence, however
   * many occurrences it missed. The next is one interval after the one that was taken, unless that is
   * already past, and then one interval from now. Returns the names that fired.
   */
  fire(now: number): string[] {
    const fired: string[] = [];
    for (const cron of this.crons.values()) {
      if (cron.nextRun > now) continue;
      if (cron.maxLimit !== null && cron.executions >= cron.maxLimit) continue;
      cron.executions += 1;
      const scheduled = cron.nextRun + cron.intervalMs;
      cron.nextRun = scheduled <= now ? now + cron.intervalMs : scheduled;
      fired.push(cron.name);
    }
    return fired;
  }
}
