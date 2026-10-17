import { expect } from 'bun:test';
import { resolve } from 'node:path';
import { Lines } from '../../packages/sdk/test/childLines';
import { testDatabaseUrl } from '../support/db';
import type { Scenario } from './scenario';
import { Ledger, reconcile, until, untilFinished } from './scenario';
import { QUEUE } from './stack';

const CRASH_WORKER = resolve(import.meta.dir, '../../packages/sdk/test/crashWorker.ts');

/** What goes wrong in a deployment: a worker dies, a publish fails, a bell arrives again. */
export const faultScenarios: readonly Scenario[] = [
  {
    name: 'worker kill -9: the lease runs out, the tick recovers the job, another worker finishes it',
    timeoutMs: 90_000,
    async run(s) {
      const queue = s.queue();
      const job = await queue.add('victim', {}, { attempts: 2 });
      // A worker process of its own, with a short lease, that starts the job and never finishes it.
      const child = Bun.spawn(
        ['bun', CRASH_WORKER, testDatabaseUrl(), s.fresh.name, s.namespace, QUEUE, '1500', '500'],
        { stdout: 'pipe', stderr: 'inherit' }
      );
      try {
        const lines = new Lines(child.stdout);
        expect(await lines.next('READY')).toBe('READY');
        expect(await lines.next('the job to start')).toBe(`STARTED ${job.id} 0`);
        expect(await s.states()).toEqual({ active: 1 });
        child.kill('SIGKILL');
        await child.exited;
      } finally {
        child.kill('SIGKILL');
      }
      const ledger = new Ledger();
      s.worker((claimed) => {
        ledger.record(claimed.id, claimed.attemptsMade);
        return 'recovered';
      });
      await untilFinished(s, [job.id], 45_000);
      // The dead worker's attempt counted; the recovery ran the job again, exactly once.
      expect(ledger.runs.get(job.id)!.map((run) => run.attemptsMade)).toEqual([1]);
      expect((await reconcile(s, [job.id])).get(job.id)).toMatchObject({
        state: 'completed',
        attempts: 1,
      });
    },
  },
  {
    name: 'publish failure: the add succeeds without a bell, and the tick (or the local poll) finds the job',
    stack: { ringGraceMs: 1_500 },
    async run(s) {
      const ledger = new Ledger();
      const warnings: string[] = [];
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      const queue = s.queue({ logger: { warn: (message) => void warnings.push(message) } });
      s.ring.failNext(1);
      const added = Date.now();
      const job = await queue.add('unlucky', {});
      expect(s.ring.calls.failed).toBe(1);
      expect(warnings.length).toBeGreaterThan(0);
      // The commit happened and the bell did not: the job exists, unrung, and nothing has run it.
      const unrung = await s.fresh.sql<Array<{ rung: boolean }>>`
        SELECT rung_at IS NOT NULL AS rung FROM qcloud_jobs WHERE id = ${job.id}`;
      expect(unrung[0]!.rung).toBe(false);
      expect(await job.getState()).toBe('waiting');
      expect(ledger.total).toBe(0);
      await untilFinished(s, [job.id], 20_000);
      const repaired = Date.now() - added;
      console.log(`[scenarios] ${s.kind}: a lost publish was repaired after ${repaired} ms`);
      if (s.kind === 'postgres') {
        // The local transport polls the store for claimable jobs: it needs no bell, nor the tick.
        expect(repaired).toBeLessThan(3_000);
      } else {
        // The tick leaves a fresh job alone for the grace, and then rings it: the grace plus a tick or two.
        expect(repaired).toBeGreaterThanOrEqual(1_000);
        expect(repaired).toBeLessThan(6_000);
      }
      expect(ledger.count(job.id)).toBe(1);
      // The add's only bell failed: the tick's bell (or the local poll) is what ran the job.
      expect(s.ring.calls.failed).toBe(1);
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'duplicate doorbell: the same bell rung three more times runs each job once',
    async run(s) {
      const ledger = new Ledger();
      const active = { now: 0, most: 0 };
      s.worker(
        async (job) => {
          active.now += 1;
          active.most = Math.max(active.most, active.now);
          ledger.record(job.id, job.attemptsMade);
          await Bun.sleep(150);
          active.now -= 1;
        },
        { concurrency: 2 }
      );
      const queue = s.queue();
      const jobs = await Promise.all(Array.from({ length: 5 }, () => queue.add('twice', {})));
      const ids = jobs.map((job) => job.id);
      const bell = (jobId?: string) => ({
        bell: { namespace: s.namespace, queue: QUEUE, ...(jobId ? { jobId } : {}) },
      });
      const results = await s.ring.ring([
        ...ids.flatMap((id) => [bell(id), bell(id), bell(id)]),
        bell(),
        bell(),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      await untilFinished(s, ids);
      // Time for a late duplicate to arrive and claim nothing.
      await Bun.sleep(900);
      for (const id of ids) expect(ledger.count(id)).toBe(1);
      expect(ledger.total).toBe(5);
      expect(active.most).toBeLessThanOrEqual(2);
      expect(await s.states()).toEqual({ completed: 5 });
      await until('no active jobs', async () => (await s.states()).active === undefined, 2_000);
      await reconcile(s, ids);
    },
  },
];
