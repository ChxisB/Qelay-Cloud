import { expect, test } from 'bun:test';
import { Ledger, reconcile, until, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import { describeDb } from '../support/db';
import { operator, targetOf, tickByHand } from './support';

/**
 * docs/runbooks/doorbells-piling-up.md (both halves) and docs/runbooks/drain-and-cut-over-queue.md:
 * inject, read the signal the runbook names, apply its fix, check the signal is gone.
 */
describeDb('game day: doorbells', () => {
  test('claimable jobs with no bell: doorbells_overdue, the tick behind; a run by hand rings them', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      await s.stopTicks();
      s.ring.failNext(4); // the broker refuses every add's bell
      const jobs = await Promise.all([1, 2, 3, 4].map((n) => s.queue().add('unrung', { n })));
      const ids = jobs.map((job) => job.id);

      // A job counts as unrung only once it is past the 2 s ring grace, and the four adds commit a few ms apart:
      // the first poll after the oldest crosses the grace can see two of them, so wait for all four.
      await until(
        'doorbells_overdue with all four unrung',
        async () =>
          (await api.codes()).includes('doorbells_overdue') &&
          (await api.deployment()).doorbells.notRung === 4,
        15_000
      );
      expect((await api.deployment()).doorbells.notRung).toBe(4);

      expect((await tickByHand(s)).ok).toBe(true);
      expect((await api.deployment()).doorbells.notRung).toBe(0);
      expect(await api.codes()).not.toContain('doorbells_overdue');
      s.worker(() => {}, { concurrency: 4 });
      await untilFinished(s, ids);
      await reconcile(s, ids);
    } finally {
      await s.drop();
    }
  }, 40_000);

  test('bells rung and nobody takes them: the broker shows a backlog until a worker exists', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      const jobs = await Promise.all([1, 2, 3].map((n) => s.queue().add('no-worker', { n })));
      await Bun.sleep(1_000);
      const waiting = async () => (await api.get('/queues/jobs/counts')).counts.waiting as number;
      expect(await waiting()).toBe(3);
      const row = (await api.get('/transport')).queues.find((q: any) => q.queue === 'jobs');
      expect(row.store.claimable).toBe(3);

      s.worker(() => {}, { concurrency: 3 });
      await untilFinished(
        s,
        jobs.map((job) => job.id)
      );
      expect(await waiting()).toBe(0);
    } finally {
      await s.drop();
    }
  }, 40_000);

  test('drain and cut over: pause, let the running job finish, new handler, resume', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      const ran = new Ledger();
      const handler = (version: string) => (job: { id: string }) =>
        void ran.record(`${version}:${job.id}`, 0);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const old = s.worker(async (job) => {
        await gate;
        handler('v1')(job);
      });
      const inFlight = await s.queue().add('in-flight', {}, { jobId: 'in-flight' });
      await until(
        'the job to be active',
        async () => (await api.get('/queues/jobs/counts')).counts.active === 1,
        10_000
      );

      await api.post('/queues/jobs/pause');
      expect((await api.get('/queues/jobs/paused')).paused).toBe(true);
      const held = await Promise.all(
        ['held-a', 'held-b'].map((jobId) => s.queue().add('held', {}, { jobId }))
      );
      open(); // the running job outlasts the pause and finishes on the old code
      await untilFinished(s, [inFlight.id]);
      expect((await api.get('/queues/jobs/counts')).counts.active).toBe(0);
      await Bun.sleep(1_000);
      expect(ran.total).toBe(1); // nothing started while paused
      expect(ran.count('v1:in-flight')).toBe(1);

      await old.close({ timeout: 1_000, graceMs: 0 }); // deploy the new code
      s.worker(handler('v2'));
      await api.post('/queues/jobs/resume');
      await untilFinished(
        s,
        held.map((job) => job.id),
        15_000
      );
      expect([ran.count('v2:held-a'), ran.count('v2:held-b'), ran.count('v1:held-a')]).toEqual([
        1, 1, 0,
      ]);

      const probe = await s.queue().add('after-resume', {}, { jobId: 'probe' });
      await untilFinished(s, [probe.id]);
      expect(ran.count('v2:probe')).toBe(1);
      expect(await api.codes()).not.toContain('tick_stale');
    } finally {
      await s.drop();
    }
  }, 60_000);
});
