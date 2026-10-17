import { expect } from 'bun:test';
import { canPeekDeadLetters } from '../../packages/core/src';
import { CONTRACT_SKIPS } from '../contract/skips';
import { FaultyTransport } from '../support/faults/faultyTransport';
import type { Scenario } from './scenario';
import { Ledger, reconcile, until, untilFinished } from './scenario';
import type { Stack } from './stack';
import { QUEUE } from './stack';

const OTHER = 'elsewhere';

/** A worker whose deliveries a scenario can count: the wrapper sits between the broker and the worker. */
function watchedWorker(
  s: Stack,
  processor: Parameters<Stack['worker']>[0],
  extra: Parameters<Stack['worker']>[1] = {},
  queue = QUEUE
): FaultyTransport {
  const watched = new FaultyTransport(s.transport());
  // A memory transport is the one the stack closes; every other kind belongs to its worker.
  s.worker(processor, { transport: watched, closeTransport: s.kind !== 'memory', ...extra }, queue);
  return watched;
}

/** What a broker does with the bells themselves, seen through a whole deployment. */
export const doorbellScenarios: readonly Scenario[] = [
  {
    name: 'half-failed ring batch: only the bells the broker took are recorded, the tick rings the rest',
    stack: { ringGraceMs: 1_500 },
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      s.ring.failItems((item) => item.bell.jobId?.startsWith('refused-') === true);
      const taken = ['a', 'b', 'c'].map((n) => `taken-${n}`);
      const refused = ['a', 'b', 'c'].map((n) => `refused-${n}`);
      await queue.addBulk(
        [...taken, ...refused].map((jobId) => ({ name: 'batch', data: {}, opts: { jobId } }))
      );
      expect(s.ring.counts.itemsFailed).toBe(3);
      const rows = await s.fresh.sql<Array<{ id: string; rung: boolean }>>`
        SELECT id, rung_at IS NOT NULL AS rung FROM qcloud_jobs WHERE namespace = ${s.namespace}`;
      const rung = new Map(rows.map((row) => [row.id, row.rung]));
      // The store was told about the three bells that went out and about no others.
      for (const id of taken) expect(rung.get(id)).toBe(true);
      for (const id of refused) expect(rung.get(id)).toBe(false);
      // Nothing is lost: the tick (or the local poll) rings the refused ones, and every job runs once.
      s.worker((job) => void ledger.record(job.id, job.attemptsMade), { concurrency: 3 });
      await untilFinished(s, [...taken, ...refused]);
      await Bun.sleep(600);
      for (const id of [...taken, ...refused]) expect(ledger.count(id)).toBe(1);
      expect(ledger.total).toBe(6);
      await reconcile(s, [...taken, ...refused]);
    },
  },
  {
    name: 'two queues: a bell for one never runs a job of the other, in either direction',
    stack: { queues: [QUEUE, OTHER] },
    async run(s) {
      const here = new Ledger();
      const there = new Ledger();
      const queueHere = s.queue({}, QUEUE);
      const queueThere = s.queue({}, OTHER);
      s.worker((job) => void here.record(job.id, job.attemptsMade), {}, QUEUE);
      s.worker((job) => void there.record(job.id, job.attemptsMade), {}, OTHER);
      const jobsHere = await Promise.all([1, 2, 3].map((n) => queueHere.add('here', { n })));
      const jobsThere = await Promise.all([1, 2].map((n) => queueThere.add('there', { n })));
      const idsHere = jobsHere.map((job) => job.id);
      const idsThere = jobsThere.map((job) => job.id);
      await untilFinished(s, [...idsHere, ...idsThere]);
      for (const id of idsHere) expect([here.count(id), there.count(id)]).toEqual([1, 0]);
      for (const id of idsThere) expect([here.count(id), there.count(id)]).toEqual([0, 1]);

      // A bell addressed to the wrong queue, naming a job that lives in the other: it claims nothing.
      const stray = await queueHere.add('stray', {}, { delay: 60_000 });
      const results = await s.ring.ring([
        { bell: { namespace: s.namespace, queue: OTHER, jobId: stray.id } },
      ]);
      expect(results).toEqual([{ ok: true }]);
      await Bun.sleep(1_200);
      expect([here.count(stray.id), there.count(stray.id)]).toEqual([0, 0]);
      expect(await stray.getState()).toBe('delayed');
    },
  },
  {
    name: 'a bell for a job that has already finished: claims nothing, is acknowledged, does not come back',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      const watched = watchedWorker(s, (job) => void ledger.record(job.id, job.attemptsMade));
      const job = await queue.add('once', {});
      await untilFinished(s, [job.id]);
      expect(ledger.count(job.id)).toBe(1);
      await Bun.sleep(500);
      const before = watched.calls.receivedBells;

      const bell = { namespace: s.namespace, queue: QUEUE, jobId: job.id };
      await s.ring.ring([{ bell }, { bell }, { bell }]);
      await until(
        'the bells to reach the worker',
        async () => watched.calls.receivedBells > before,
        15_000
      );
      // Past the longest redelivery any transport here has: an acknowledged bell stays gone.
      await Bun.sleep(4_000);
      const settled = watched.calls.receivedBells;
      await Bun.sleep(2_000);
      expect(watched.calls.receivedBells).toBe(settled);
      expect(ledger.count(job.id)).toBe(1);
      expect(await s.states()).toEqual({ completed: 1 });
      const stats = await watched.stats(QUEUE);
      if (stats.deadLetterDepth !== null) expect(stats.deadLetterDepth).toBe(0);
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'a long job holds no bell: the bell is acknowledged when the claim was attempted, not when the job ends',
    timeoutMs: 90_000,
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      // Longer than the 3 s visibility timeout the SQS stack uses: a bell held until the end would be
      // handed out again while the job runs.
      const watched = watchedWorker(s, async (job) => {
        ledger.record(job.id, job.attemptsMade);
        await Bun.sleep(5_000);
      });
      const job = await queue.add('long', {});
      await untilFinished(s, [job.id], 30_000);
      await Bun.sleep(1_500);
      expect(ledger.count(job.id)).toBe(1);
      // The one bell was handed over once: had it been held until the end, the broker would have
      // brought it back, and the claim it made would have found a job already running.
      expect(watched.calls.receivedBells).toBe(1);
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'a malformed bell: it ends in the dead-letter queue, is counted, and the jobs behind it still run',
    timeoutMs: 120_000,
    skip: {
      memory: CONTRACT_SKIPS.memory.poison ?? 'no malformed bell can be made',
      postgres: CONTRACT_SKIPS['postgres-local'].poison ?? 'no malformed bell can be made',
    },
    async run(s) {
      expect(s.poison).toBeDefined();
      const ledger = new Ledger();
      const queue = s.queue();
      const watched = watchedWorker(s, (job) => void ledger.record(job.id, job.attemptsMade));
      await s.poison?.(QUEUE);
      const job = await queue.add('behind-it', {});
      await untilFinished(s, [job.id]);
      expect(ledger.count(job.id)).toBe(1);

      const peek = canPeekDeadLetters(watched) ? watched : null;
      expect(peek).not.toBeNull();
      await until(
        'the malformed bell in the dead-letter queue',
        async () => (await peek?.peekDeadLetters(QUEUE, 10))?.length === 1,
        s.deadLetterAfterMs ?? 60_000
      );
      const [letter] = (await peek?.peekDeadLetters(QUEUE, 10)) ?? [];
      expect(letter?.bell).toBeNull();
      // A dead letter is a metric: nothing replays it, and no job came out of it.
      const stats = await watched.stats(QUEUE);
      if (stats.deadLetterDepth !== null) expect(stats.deadLetterDepth).toBeGreaterThanOrEqual(1);
      await Bun.sleep(1_500);
      expect(ledger.total).toBe(1);
      expect(await s.states()).toEqual({ completed: 1 });
      await reconcile(s, [job.id]);
    },
  },
  {
    name: 'a delay is rung ahead only inside the transport window: never early, never clamped, repaired by the tick',
    async run(s) {
      const ledger = new Ledger();
      const queue = s.queue();
      s.worker((job) => void ledger.record(job.id, job.attemptsMade));
      const DELAY = 20_000;
      const job = await queue.add('windowed', {}, { delay: DELAY });
      expect(await job.getState()).toBe('delayed');
      const rows = await s.fresh.sql<Array<{ rung: boolean }>>`
        SELECT rung_at IS NOT NULL AS rung FROM qcloud_jobs WHERE id = ${job.id}`;
      // The capability decides, and nothing else: a window that covers the delay takes the bell now,
      // a window that does not (Pub/Sub's is zero) leaves it to the tick, which rings it nearer its time.
      expect(rows[0]!.rung).toBe(DELAY <= s.store.ringWindowMs);
      expect(s.ring.counts.forwarded).toBe(DELAY <= s.store.ringWindowMs ? 1 : 0);
      await Bun.sleep(1_200);
      expect(ledger.total).toBe(0);
      expect(await s.states()).toEqual({ delayed: 1 });
      // Pull the time forward rather than wait it out: what is checked is the tick and the claim.
      await s.fresh.sql`
        UPDATE qcloud_jobs SET run_at = run_at - ${DELAY + 1_000}::bigint,
          rung_at = rung_at - ${DELAY + 1_000}::bigint
        WHERE id = ${job.id}`;
      await untilFinished(s, [job.id], 30_000);
      expect(ledger.count(job.id)).toBe(1);
      await reconcile(s, [job.id]);
    },
  },
];
