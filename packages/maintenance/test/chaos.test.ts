import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { makeTransport } from '../../transport-local/test/support';
import type { ChaosOptions, ChaosResult } from './chaos';
import { runChaos } from './chaos';

const QUEUES = ['alpha', 'beta'];

async function attemptsOf(t: TestStore, ids: readonly string[]): Promise<Map<string, number>> {
  const rows = await t.fresh.sql<{ id: string; attempts: number }[]>`
    SELECT id, attempts FROM qcloud_jobs WHERE id = ANY(${t.fresh.sql.array([...ids], 'TEXT')})`;
  return new Map(rows.map((row) => [row.id, row.attempts]));
}

function expectSurvived(result: ChaosResult): void {
  expect(result.violations).toEqual([]);
  expect(result.notCompleted).toBe(0);
  expect(result.doubleCompleted).toBe(0);
  expect(result.attemptMismatches).toBe(0);
  expect(result.telemetryErrors).toBe(0);
  // The faults really happened, so the survival means something.
  expect(result.enqueued).toBeGreaterThan(40);
  expect(result.dropped).toBeGreaterThan(result.enqueued * 0.3);
  expect(result.crashes).toBeGreaterThan(5);
}

describeDb(
  'chaos on the memory transport: half the bells lost, workers dying, delayed jobs',
  () => {
    let t: TestStore;
    beforeAll(async () => {
      t = await openTestStore({ ringWindowMs: 3_600_000, leaseMs: 3_000, poolSize: 8 });
    });
    afterAll(async () => {
      await t.drop();
    });
    beforeEach(async () => {
      await resetTables(t);
    });

    async function run(seed: number, over: Partial<ChaosOptions> = {}): Promise<ChaosResult> {
      const inner = new MemoryTransport({ clock: t.clock });
      try {
        return await runChaos({
          store: t.store,
          inner,
          time: {
            now: () => t.clock.now(),
            pass: async (ms) => t.clock.advance(ms),
            settle: async () => {
              inner.tick();
              await inner.idle();
            },
          },
          seed,
          queues: QUEUES,
          dropRate: 0.5,
          crashRate: 0.2,
          delayedShare: 0.25,
          maxDelayMs: 6_000,
          intervalMs: 1_000,
          leaseMs: 3_000,
          stepMs: 250,
          steps: 240,
          drainSteps: 80,
          jitterMs: 0,
          attemptsOf: (ids) => attemptsOf(t, ids),
          describeJob: async (id) =>
            JSON.stringify(
              (
                await t.fresh
                  .sql`SELECT state, attempts, run_at, rung_at, lease_until FROM qcloud_jobs WHERE id = ${id}`
              )[0]
            ),
          ...over,
        });
      } finally {
        await inner.close();
      }
    }

    test.each([20_261_020, 20_261_021, 20_261_022])(
      'seed %i: no job is lost, none waits without a bell past the bound, every one completes once',
      async (seed) => {
        const result = await run(seed);
        expectSurvived(result);
        // The worst gap is inside the bound the contract names: the re-ring age plus one interval.
        expect(result.worstBellGapMs).toBeLessThanOrEqual(result.boundMs);
      },
      60_000
    );

    test('a longer re-ring age, still within the interval, moves the bound with it', async () => {
      const result = await run(20_261_023, {
        intervalMs: 2_000,
        leaseMs: 3_000,
        tick: { reRingAfterMs: 1_500 },
      });
      expectSurvived(result);
      expect(result.boundMs).toBe(1_500 + 2_000 + 250);
      expect(result.worstBellGapMs).toBeLessThanOrEqual(result.boundMs);
    }, 60_000);

    test('the control: with no ticks, the same faults break the bound and strand jobs', async () => {
      const result = await run(20_261_020, { ticks: false });
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.notCompleted).toBeGreaterThan(0);
    }, 60_000);
  }
);

describeDb('chaos on the local transport: real timers, NOTIFY only, the poll loop off', () => {
  let t: TestStore;
  beforeAll(async () => {
    // The database clock, since the transport runs on real timers.
    t = await openTestStore({ clock: null, ringWindowMs: 3_600_000, leaseMs: 1_200, poolSize: 10 });
  });
  afterAll(async () => {
    await t.drop();
  });

  test('half the NOTIFYs lost and workers dying: the tick alone keeps every job moving', async () => {
    // The transport's own poll loop would repair a lost bell too; a minute makes it irrelevant
    // here, so what is measured is the tick.
    const inner = makeTransport(t, { pollIntervalMs: 60_000 });
    try {
      const result = await runChaos({
        store: t.store,
        inner,
        time: {
          now: () => Date.now(),
          pass: (ms) => Bun.sleep(ms),
          settle: () => Bun.sleep(40),
        },
        seed: 20_261_024,
        queues: QUEUES,
        dropRate: 0.5,
        crashRate: 0.2,
        delayedShare: 0,
        maxDelayMs: 0,
        intervalMs: 400,
        leaseMs: 1_200,
        stepMs: 100,
        steps: 60,
        drainSteps: 40,
        jitterMs: 300,
        attemptsOf: (ids) => attemptsOf(t, ids),
      });
      expectSurvived(result);
    } finally {
      await inner.close();
    }
  }, 60_000);
});
