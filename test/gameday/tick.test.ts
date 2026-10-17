import { expect, test } from 'bun:test';
import { Ledger, until, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import { describeDb } from '../support/db';
import { operator, targetOf, tickByHand } from './support';

/**
 * docs/runbooks/tick-stopped.md. Each drill breaks the tick, reads what the alert reads (`/deployment`
 * as the runbook's first command does), applies the runbook's fix and checks the signal is gone.
 */
describeDb('game day: the tick', () => {
  test('stopped: workers keep going, tick_stale shows, one run by hand clears it', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      await until('a first tick', async () => (await api.deployment()).tick.state === 'ok', 10_000);
      await s.stopTicks();

      // What the runbook calls safe: a bell that is rung is still taken while nothing repairs.
      const ledger = new Ledger();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      const job = await s.queue().add('while-stopped', {});
      await untilFinished(s, [job.id]);
      expect(ledger.count(job.id)).toBe(1);

      await until('tick_stale', async () => (await api.codes()).includes('tick_stale'), 15_000);
      expect((await api.deployment()).tick.state).toBe('stale');

      const report = await tickByHand(s);
      expect(report.ok).toBe(true);
      const after = await api.deployment();
      expect(after.tick.state).toBe('ok');
      expect(after.tick.ageMs).toBeLessThan(1_000);
      expect(await api.codes()).not.toContain('tick_stale');
    } finally {
      await s.drop();
    }
  }, 40_000);

  test('failing: the broker refuses the ring, lastFailureAt passes lastSuccessAt, fixing the broker clears it', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      await s.stopTicks();
      s.ring.failNext(1); // the add's own bell is refused: the job is in Postgres with no bell
      const job = await s.queue().add('unrung', {});
      await Bun.sleep(300); // past the grace that protects a fresh enqueue

      s.ring.failNext(5);
      const failed = await tickByHand(s);
      expect(failed.ok).toBe(false);
      expect(failed.ring.unreachable).toBeGreaterThan(0);
      const { tick } = await api.deployment();
      expect(tick.lastFailureAt).toBeGreaterThan(tick.lastSuccessAt ?? 0);

      s.ring.clearFaults();
      const fixed = await tickByHand(s);
      expect(fixed.ok).toBe(true);
      expect(fixed.ring.rung).toBeGreaterThan(0);
      const healed = (await api.deployment()).tick;
      expect(healed.lastSuccessAt).toBeGreaterThan(healed.lastFailureAt);
      s.worker(() => {});
      await untilFinished(s, [job.id]);
    } finally {
      await s.drop();
    }
  }, 40_000);
});
