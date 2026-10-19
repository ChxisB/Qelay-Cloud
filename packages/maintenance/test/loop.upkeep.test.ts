import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { TickLoop } from '../src/loop';
import type { TickLoopOptions } from '../src/loop';
import { RecordingTransport } from './support';

/** A store that only answers a beat, and records whether each tick was told to skip the upkeep steps. */
function fakeStore(skips: boolean[]): PostgresStore {
  return {
    ringWindowMs: 0,
    tick: async (budget: { skipUpkeep?: boolean }) => {
      skips.push(budget.skipUpkeep === true);
      return { recovered: 0, promoted: 0, cronFired: 0, expired: 0, rings: [], moreWork: false };
    },
    metrics: { totals: async () => ({ completed: 0, failed: 0 }) },
    maintenance: {
      acquireTickLease: async () => ({ held: true }),
      recordTick: async () => {},
      releaseTickLease: async () => {},
    },
  } as unknown as PostgresStore;
}

const beats = async (options: TickLoopOptions, gaps: number[] = [0, 0, 0]): Promise<boolean[]> => {
  const skips: boolean[] = [];
  const loop = new TickLoop(
    { store: fakeStore(skips), transport: new RecordingTransport() },
    { intervalMs: 1_000, ...options }
  );
  for (const gap of gaps) {
    await Bun.sleep(gap);
    await loop.beat();
  }
  return skips;
};

describe('TickLoop: upkeep between beats', () => {
  test('by default every beat does the upkeep, as a scheduler-called tick does', async () => {
    expect(await beats({})).toEqual([false, false, false]);
  });

  test('with upkeepEveryMs the first beat does it and the next ones skip it until the time is up', async () => {
    expect(await beats({ upkeepEveryMs: 60_000 })).toEqual([false, true, true]);
    expect(await beats({ upkeepEveryMs: 40 }, [0, 0, 60, 0])).toEqual([false, true, false, true]);
  });
});
