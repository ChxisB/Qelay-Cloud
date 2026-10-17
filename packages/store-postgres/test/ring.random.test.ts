import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Lease, TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

/** A small seeded generator, so a failing run replays from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const QUEUES = ['alpha', 'beta', 'gamma'];
const RE_RING_AFTER_MS = 5_000;
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 1_000,
  maxItems: 1_000,
  reRingAfterMs: RE_RING_AFTER_MS,
  ringGraceMs: 0,
};

interface PendingRow {
  id: string;
  queue: string;
  state: string;
  run_at: string;
  rung_at: string | null;
}

describeDb('ring query: nothing claimable goes without a bell (randomised)', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 30_000, leaseMs: 20_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** Jobs a worker could claim right now, in queues that are not paused. */
  const claimable = async (): Promise<PendingRow[]> => {
    const now = t.clock.now();
    return t.fresh.sql<PendingRow[]>`
      SELECT job.id, job.queue, job.state, job.run_at, job.rung_at FROM qcloud_jobs job
      WHERE (job.state IN ('waiting', 'prioritized') OR (job.state = 'delayed' AND job.run_at <= ${now}))
        AND NOT EXISTS (SELECT 1 FROM qcloud_queue_state state
                        WHERE state.namespace = job.namespace AND state.queue = job.queue AND state.paused)`;
  };

  /** One round of random work, then a tick whose publishes are dropped or half-reported at random. */
  async function round(random: () => number, held: Lease[]): Promise<void> {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    for (let n = Math.floor(random() * 5); n > 0; n--) {
      await t.store.enqueue([
        {
          queue: pick(QUEUES),
          data: n,
          options: {
            delay: random() < 0.3 ? 1_000 + Math.floor(random() * 90_000) : 0,
            priority: random() < 0.3 ? 1 + Math.floor(random() * 3) : 0,
            attempts: 3,
            backoff: random() < 0.5 ? 0 : 3_000,
          },
        },
      ]);
    }
    if (random() < 0.5) {
      for (const job of await t.store.claim(pick(QUEUES), 'w', 1 + Math.floor(random() * 3))) {
        held.push(job.lease);
      }
    }
    for (const lease of held.splice(0, Math.floor(random() * 3))) {
      const action = random();
      if (action < 0.3) await t.store.complete(lease, null);
      else if (action < 0.6) await t.store.fail(lease, { message: 'x', unrecoverable: false });
      else if (action < 0.8) await t.store.release(lease);
      // otherwise the worker dies: the lease runs out and the tick recovers the job
    }
    if (random() < 0.1) {
      const queue = pick(QUEUES);
      await (random() < 0.5 ? t.store.pause(queue) : t.store.resume(queue));
    }
    t.clock.advance(random() < 0.15 ? 25_000 : 1_000 + Math.floor(random() * 6_000));

    const { rings } = await t.store.tick(BUDGET);
    // Every claimable job is in this tick's rings, or has a bell younger than the threshold.
    const rung = new Set(rings.map((ring) => ring.bell.jobId));
    const now = t.clock.now();
    const stuck = (await claimable()).filter(
      (row) =>
        !rung.has(row.id) && (row.rung_at === null || Number(row.rung_at) <= now - RE_RING_AFTER_MS)
    );
    expect(stuck).toEqual([]);

    // The publishes: each ring reaches the broker or not, and a batch is reported in part or whole.
    // A ring that is dropped or unreported leaves its job as it was, so the next round's check is
    // what proves the tick finds it again.
    const reached = rings.filter(() => random() < 0.7);
    const reported = random() < 0.2 ? reached.slice(0, Math.floor(reached.length / 2)) : reached;
    await t.store.markRung(
      reported.map((ring) => ({ jobId: ring.bell.jobId!, deliverAfterMs: ring.dueInMs }))
    );
  }

  test.each(Array.from({ length: 16 }, (_, seed) => seed + 1))(
    'seed %d: 30 rounds of work, dropped publishes and half-reported batches',
    async (seed) => {
      const random = mulberry32(seed);
      const held: Lease[] = [];
      for (let n = 0; n < 30; n++) await round(random, held);
    },
    60_000
  );

  test('a bell nobody reports is found again on every later tick', async () => {
    await t.store.enqueue([{ queue: 'alpha', data: 1 }]);
    for (let tick = 0; tick < 4; tick++) {
      t.clock.advance(RE_RING_AFTER_MS);
      expect((await t.store.tick(BUDGET)).rings).toHaveLength(1);
    }
  });
});
