import { expect, spyOn, test } from 'bun:test';
import { Ledger, reconcile, until, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import { describeDb, testDatabaseUrl } from '../support/db';
import { TcpProxy } from '../support/tcpProxy';
import type { Wire } from './support';
import { counters, operator, targetOf, urlVia } from './support';

/**
 * docs/runbooks/lease-loss-storm.md, dead-letter-queue-growing.md and clock-skew.md: the signals the
 * runbooks name (counters a sink receives, the DLQ routes, the tick's age) and the fix each one gives.
 */
describeDb('game day: workers', () => {
  test('lease-loss storm: the worker cannot reach the database, the counters rise, the job runs twice, a healthy path stops them', async () => {
    const s = await openStack('postgres');
    const proxy = await TcpProxy.start({
      targetHost: '127.0.0.1',
      targetPort: Number(new URL(testDatabaseUrl()).port),
    });
    try {
      const metrics = counters();
      const ran = new Ledger();
      let hang = true;
      const handler = (
        job: { id: string; attemptsMade: number },
        context: { signal: AbortSignal }
      ) => {
        ran.record(job.id, job.attemptsMade);
        return hang
          ? new Promise<void>((_, reject) =>
              context.signal.addEventListener('abort', () => reject(context.signal.reason))
            )
          : Promise.resolve();
      };
      const lossy = s.worker(handler as never, {
        databaseUrl: urlVia(proxy.port),
        lockDuration: 600,
        metrics: metrics.sink,
      });
      lossy.on('error', () => {});
      const job = await s.queue().add('stormy', {}, { jobId: 'stormy', attempts: 3 });
      await until('the job to start', () => ran.count(job.id) === 1);

      await proxy.refuse(); // the database is out of this worker's reach: no heartbeat can be confirmed
      await until('lease_lost', () => metrics.get('qcloud.worker.lease_lost') > 0, 5_000);
      expect(metrics.get('qcloud.worker.heartbeat_failed')).toBeGreaterThan(0); // the runbook: it says why

      // Nothing was written by the worker that lost the job; the tick took it back once the lease ran out.
      hang = false;
      s.worker(handler as never); // a healthy worker, on the direct path
      await untilFinished(s, [job.id], 15_000);
      expect(ran.count(job.id)).toBeGreaterThanOrEqual(2); // at least once, as the runbook says
      await reconcile(s, [job.id]);

      // Verify: with the cause gone the counters stop rising.
      await proxy.accept();
      await Bun.sleep(1_000);
      const settled = [
        metrics.get('qcloud.worker.lease_lost'),
        metrics.get('qcloud.worker.heartbeat_failed'),
      ];
      const more = await s
        .queue()
        .addBulk(Array.from({ length: 3 }, (_, n) => ({ name: 'calm', data: { n } })));
      await untilFinished(
        s,
        more.map((j) => j.id)
      );
      await Bun.sleep(1_000);
      expect([
        metrics.get('qcloud.worker.lease_lost'),
        metrics.get('qcloud.worker.heartbeat_failed'),
      ]).toEqual(settled);
    } finally {
      await proxy.stop().catch(() => {});
      await s.drop();
    }
  }, 60_000);

  test('jobs failing for good: the summary and the DLQ say which and why, a fixed handler runs the re-added work', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      const broken = s.worker(() => {
        throw new Error('upstream API changed');
      });
      const jobs = await s.queue().addBulk(
        Array.from({ length: 4 }, (_, n) => ({
          name: 'charge',
          data: { n },
          opts: { jobId: `charge-${n}`, attempts: 1 },
        }))
      );
      await untilFinished(
        s,
        jobs.map((job) => job.id)
      );

      const [row] = (await api.get('/queues/summary')) as unknown as Wire[]; // an array, not an object
      expect(row).toMatchObject({ name: 'jobs', counts: { failed: 4 } });
      expect((await api.get('/queues/jobs/dlq/stats')).stats).toMatchObject({
        total: 4,
        byReason: { max_attempts_exceeded: 4 },
      });
      const { entries } = await api.get('/queues/jobs/dlq');
      expect(entries.map((e: any) => e.error)).toEqual(Array(4).fill('upstream API changed'));
      expect((await s.store.metrics.totals()).failed).toBe(4); // what the optional failed_total alert reads
      expect((await api.call('POST', '/queues/jobs/dlq/retry')).status).toBe(501); // retry is not offered: the runbook says so

      // Fix the handler, add the work again from the entries' own data: new jobs, new ids.
      await broken.close({ timeout: 1_000, graceMs: 0 });
      const ran = new Ledger();
      s.worker((job) => void ran.record(job.id, job.attemptsMade));
      const again = [];
      for (const entry of entries) {
        const { job } = await api.get(`/jobs/${entry.job.id}`);
        again.push(await s.queue().add(job.name, job.data, { jobId: `${job.id}-again` }));
      }
      await untilFinished(
        s,
        again.map((job) => job.id)
      );
      expect(ran.total).toBe(4);
      expect((await s.store.metrics.totals()).failed).toBe(4); // stopped rising
    } finally {
      await s.drop();
    }
  }, 60_000);

  test('clock skew: a host an hour off changes neither when a delayed job runs nor the tick age', async () => {
    const s = await openStack('postgres');
    const real = Date.now.bind(Date);
    const skew = (ms: number) => spyOn(Date, 'now').mockImplementation(() => real() + ms);
    try {
      const api = operator(targetOf(s));
      const ran = new Ledger();
      s.worker((job) => void ran.record(job.id, 0));
      for (const ms of [3_600_000, -3_600_000]) {
        const spy = skew(ms);
        try {
          const id = `delayed${ms > 0 ? '-fast' : '-slow'}`;
          const startedAt = performance.now();
          await s.queue().add('later', {}, { jobId: id, delay: 1_200 });
          await Bun.sleep(500);
          expect(ran.count(id)).toBe(0); // a clock an hour ahead did not bring it forward
          await until(id, () => ran.count(id) === 1, 8_000); // and one an hour behind did not push it out
          expect(performance.now() - startedAt).toBeLessThan(4_000);
          expect((await api.deployment()).tick.state).toBe('ok');
          expect((await api.deployment()).tick.ageMs).toBeLessThan(1_000);
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      await s.drop();
    }
  }, 60_000);
});
