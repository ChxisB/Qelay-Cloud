import { expect } from 'bun:test';
import type { Scenario } from './scenario';
import { dbNow, Ledger, reconcile, until, untilFinished } from './scenario';
import type { Stack } from './stack';
import { QUEUE } from './stack';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The jobs a cron made: a scenario with a cron has no other job in its (fresh) stack. */
async function cronJobs(s: Stack): Promise<Array<{ id: string; created: number }>> {
  const rows = await s.fresh.sql<Array<{ id: string; created: string }>>`
    SELECT id, created_at AS created FROM qcloud_jobs
    WHERE namespace = ${s.namespace} AND queue = ${QUEUE}
    ORDER BY created_at, id`;
  return rows.map((row) => ({ id: row.id, created: Number(row.created) }));
}

async function executions(s: Stack, name: string): Promise<number> {
  const cron = (await s.store.crons.list()).find((c) => c.name === name);
  return cron?.executions ?? 0;
}

/** Delay, and the recurring jobs the tick creates. */
export const scheduleScenarios: readonly Scenario[] = [
  {
    name: 'a delay of seconds: the job is never early, and late by no more than the transport and tick',
    async run(s) {
      const ledger = new Ledger();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      const queue = s.queue();
      const before = Date.now();
      const job = await queue.add('later', {}, { delay: 1_500 });
      expect(await job.getState()).toBe('delayed');
      await untilFinished(s, [job.id]);
      const lateness = ledger.runs.get(job.id)![0]!.at - before - 1_500;
      console.log(`[scenarios] ${s.kind}: a 1,500 ms delay ran ${lateness} ms after its time`);
      // Not early (the add's own clock reading can be a few ms ahead of the database's).
      expect(lateness).toBeGreaterThanOrEqual(-50);
      // Late by at most the tick interval, the transport's poll and the claim, a few hundred ms.
      expect(lateness).toBeLessThan(2_500);
      expect(ledger.count(job.id)).toBe(1);
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'a delay of hours: the job waits as delayed, and runs once its time has come',
    async run(s) {
      const ledger = new Ledger();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      const queue = s.queue();
      const job = await queue.add('much-later', {}, { delay: HOUR });
      expect(await job.getState()).toBe('delayed');
      // Neither the tick nor the transport runs it early, whatever was rung ahead of time.
      await Bun.sleep(1_200);
      expect(ledger.total).toBe(0);
      expect(await s.states()).toEqual({ delayed: 1 });
      const dueIn = await s.fresh.sql<Array<{ left: string }>>`
        SELECT run_at - ${await dbNow(s)}::bigint AS left FROM qcloud_jobs WHERE id = ${job.id}`;
      expect(Number(dueIn[0]!.left)).toBeGreaterThan(HOUR - 5_000);
      // The hour is pulled forward instead of waited for: the job's due time moves into the past. A job rung
      // ahead of its time carries the due time as `rung_at` too, so both move. This tests what the tick and
      // the claim do when the time comes, not a broker holding a bell for an hour (the transport contract
      // suite covers the delay, and Pub/Sub's own timing is a real-cloud question).
      await s.fresh.sql`
        UPDATE qcloud_jobs SET run_at = run_at - ${HOUR + 1_000}::bigint,
          rung_at = rung_at - ${HOUR + 1_000}::bigint
        WHERE id = ${job.id}`;
      await untilFinished(s, [job.id]);
      expect(ledger.count(job.id)).toBe(1);
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'a cron every 250 ms, ten times, on two tick loops: no occurrence missed or doubled',
    stack: { tickLoops: 2 },
    async run(s) {
      const ledger = new Ledger();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      await s.store.crons.upsert({
        name: 'fast',
        queue: QUEUE,
        jobName: 'fast',
        repeatEvery: 250,
        maxLimit: 10,
        preventOverlap: false,
      });
      await until('ten executions', async () => (await executions(s, 'fast')) === 10, 15_000);
      // Two loops contend for the lease. Had both fired an occurrence, the count would reach ten early.
      const jobs = await cronJobs(s);
      await untilFinished(
        s,
        jobs.map((job) => job.id)
      );
      await Bun.sleep(600);
      expect(await executions(s, 'fast')).toBe(10);
      const after = await cronJobs(s);
      expect(after.length).toBe(10);
      expect(new Set(after.map((job) => job.id)).size).toBe(10);
      // Each occurrence is made by its own beat, and beats are 200 ms apart minus whatever a busy event loop
      // makes the loop catch up (134 ms was seen under a full suite). A doubled fire is two jobs of one beat,
      // a few ms apart, so 50 ms separates the two without depending on the machine.
      for (let n = 1; n < after.length; n += 1) {
        expect(after[n]!.created - after[n - 1]!.created).toBeGreaterThanOrEqual(50);
      }
      for (const job of after) expect(ledger.count(job.id)).toBe(1);
      await reconcile(
        s,
        after.map((job) => job.id)
      );
    },
  },
  {
    name: 'a cron every minute, ten minutes (the clock pulled forward): one job per minute',
    async run(s) {
      // A real minute boundary during the test would be a legitimate extra fire; start just after one.
      const into = (await dbNow(s)) % MINUTE;
      if (into > 45_000) await Bun.sleep(MINUTE - into + 200);
      const ledger = new Ledger();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      await s.store.crons.upsert({
        name: 'every-minute',
        queue: QUEUE,
        jobName: 'every-minute',
        schedule: '* * * * *',
        maxLimit: 10,
        preventOverlap: false,
      });
      const created = (await s.store.crons.list()).find((c) => c.name === 'every-minute')!;
      // The first occurrence is the next minute boundary of the wall clock, not now.
      expect(created.nextRun % MINUTE).toBe(0);
      expect(created.nextRun).toBeGreaterThan(await dbNow(s));
      expect(created.nextRun - (await dbNow(s))).toBeLessThanOrEqual(MINUTE);
      for (let minute = 1; minute <= 10; minute += 1) {
        // Minute `n` arrives: its due time moves into the past, as the real clock would carry it.
        await s.fresh.sql`
          UPDATE qcloud_crons SET next_run = ${(await dbNow(s)) - 1_000}::bigint
          WHERE namespace = ${s.namespace} AND name = 'every-minute'`;
        await until(
          `minute ${minute}'s occurrence`,
          async () => (await executions(s, 'every-minute')) >= minute,
          10_000
        );
        // Settle: a second tick pass must not fire the same minute again.
        await Bun.sleep(450);
        expect(await executions(s, 'every-minute')).toBe(minute);
      }
      const jobs = await cronJobs(s);
      expect(jobs.length).toBe(10);
      await untilFinished(
        s,
        jobs.map((job) => job.id)
      );
      for (const job of jobs) expect(ledger.count(job.id)).toBe(1);
      const done = (await s.store.crons.list()).find((c) => c.name === 'every-minute')!;
      expect(done.executions).toBe(10);
      await reconcile(
        s,
        jobs.map((job) => job.id)
      );
    },
  },
];
