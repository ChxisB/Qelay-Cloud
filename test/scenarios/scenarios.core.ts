import { expect } from 'bun:test';
import type { Scenario } from './scenario';
import { Ledger, reconcile, untilFinished } from './scenario';
import { QUEUE } from './stack';

/** The life of a job: add, run, retry, fail into the dead-letter queue, wait, pause, order. */
export const coreScenarios: readonly Scenario[] = [
  {
    name: 'enqueue and complete: every job runs once and keeps its result',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue<{ n: number }>();
      s.worker<{ n: number }, { doubled: number }>(
        (job) => {
          ledger.record(job.id, job.attemptsMade);
          return { doubled: job.data.n * 2 };
        },
        { concurrency: 4 }
      );
      const jobs = await Promise.all(
        Array.from({ length: 20 }, (_, n) => queue.add('double', { n }))
      );
      const ids = jobs.map((job) => job.id);
      await untilFinished(s, ids);
      const states = await reconcile(s, ids);
      for (const id of ids) {
        expect(ledger.count(id)).toBe(1);
        // `attempts` counts the tries that failed or lost their lease: a job that worked at once has none.
        expect(states.get(id)).toMatchObject({ state: 'completed', attempts: 0 });
      }
      const read = await queue.getJob<{ doubled: number }>(ids[7]!);
      expect(read?.returnvalue).toEqual({ doubled: 14 });
      expect(await s.states()).toEqual({ completed: 20 });
    },
  },
  {
    name: 'retry with backoff, then success: the retry waits its backoff and no longer',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      s.worker((job) => {
        const run = ledger.record(job.id, job.attemptsMade);
        if (run < 3) throw new Error(`attempt ${run} fails`);
        return 'done';
      });
      const job = await queue.add(
        'flaky',
        {},
        { attempts: 3, backoff: { type: 'fixed', delay: 600 } }
      );
      await untilFinished(s, [job.id]);
      const runs = ledger.runs.get(job.id)!;
      expect(runs.map((run) => run.attemptsMade)).toEqual([0, 1, 2]);
      // Never early: the backoff is a floor. On any transport the retry is late by at most the
      // poll or tick that finds it, a few seconds here.
      for (const [from, to] of [
        [0, 1],
        [1, 2],
      ] as const) {
        const gap = runs[to]!.at - runs[from]!.at;
        expect(gap).toBeGreaterThanOrEqual(550);
        expect(gap).toBeLessThan(5_000);
      }
      expect((await reconcile(s, [job.id])).get(job.id)).toMatchObject({
        state: 'completed',
        attempts: 2,
      });
    },
  },
  {
    name: 'exhaust the retries: the job fails into the dead-letter queue with its reason',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      s.worker((job) => {
        ledger.record(job.id, job.attemptsMade);
        throw new Error('always fails');
      });
      const job = await queue.add(
        'doomed',
        { what: 'never works' },
        { attempts: 2, backoff: { type: 'fixed', delay: 200 } }
      );
      await untilFinished(s, [job.id]);
      expect(ledger.count(job.id)).toBe(2);
      expect((await reconcile(s, [job.id])).get(job.id)).toMatchObject({
        state: 'failed',
        attempts: 2,
      });
      const entries = await queue.getDlq();
      expect(entries.map((entry) => entry.jobId)).toEqual([job.id]);
      expect(entries[0]).toMatchObject({ queue: QUEUE, attempts: 2 });
      expect(entries[0]!.reason).toBe('max_attempts_exceeded');
      expect((await queue.getJob(job.id))?.failedReason).toContain('always fails');
      expect((await queue.getDlqStats()).total).toBe(1);
      // A job in the dead-letter queue is finished: nothing runs it a third time.
      await Bun.sleep(1_000);
      expect(ledger.count(job.id)).toBe(2);
    },
  },
  {
    name: 'pause and resume: nothing runs while paused, everything runs after',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade), { concurrency: 2 });
      await queue.pause();
      expect(await queue.isPaused()).toBe(true);
      const ids = (await Promise.all(Array.from({ length: 6 }, () => queue.add('held', {})))).map(
        (job) => job.id
      );
      // Past one tick interval and a poll, so a bell that ignored the pause would have run a job.
      await Bun.sleep(1_200);
      expect(ledger.total).toBe(0);
      expect(await s.states()).toEqual({ waiting: 6 });
      await queue.resume();
      await untilFinished(s, ids);
      for (const id of ids) expect(ledger.count(id)).toBe(1);
      await reconcile(s, ids);
    },
  },
  {
    name: 'priority order: the highest priority runs first, then admission order',
    async run(s) {
      const ledger = new Ledger();
      const order: string[] = [];
      const queue = s.queue();
      await queue.pause();
      const priorities = [1, 3, 2, 3, 1, 2, 3, 0];
      const jobs = [];
      for (const [n, priority] of priorities.entries()) {
        jobs.push(await queue.add(`p${n}`, { n }, { priority }));
      }
      s.worker(
        (job) => {
          ledger.record(job.id, job.attemptsMade);
          order.push(job.name);
        },
        { concurrency: 1 }
      );
      await queue.resume();
      const ids = jobs.map((job) => job.id);
      await untilFinished(s, ids);
      const expected = priorities
        .map((priority, n) => ({ priority, n }))
        .sort((a, b) => b.priority - a.priority || a.n - b.n)
        .map(({ n }) => `p${n}`);
      expect(order).toEqual(expected);
      await reconcile(s, ids);
    },
  },
];
