/** The recurring job. The tick fires cron entries, so a deployment needs a tick (see README). */
import type { PostgresStore } from '../../../packages/store-postgres/src';
import { JOBS, QUEUE } from './jobs';

/**
 * Registers the daily report: every day at 06:00 UTC in production. The cron floor is one minute, which is
 * the Cloud Scheduler period; `everyMs` is for the demo and the test, which cannot wait a day.
 */
export async function registerReport(
  store: PostgresStore,
  options: { readonly everyMs?: number; readonly times?: number } = {}
): Promise<void> {
  await store.crons.upsert({
    name: JOBS.report,
    queue: QUEUE,
    jobName: JOBS.report,
    preventOverlap: false,
    ...(options.everyMs === undefined
      ? { schedule: '0 6 * * *' }
      : { repeatEvery: options.everyMs, maxLimit: options.times ?? 3 }),
  });
}
