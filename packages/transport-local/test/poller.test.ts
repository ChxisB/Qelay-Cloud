import { describe, expect, test } from 'bun:test';
import type { PollerOptions } from '../src/poller';
import { QueuePoller } from '../src/poller';

function rig(overrides: Partial<PollerOptions> = {}) {
  const counts = { ticks: 0, probes: 0, pokes: 0 };
  const options: PollerOptions = {
    intervalMs: 10,
    jitter: 0,
    random: () => 0.5,
    capacity: () => 1,
    tick: () => {
      counts.ticks += 1;
    },
    drained: () => true,
    hasClaimable: async () => {
      counts.probes += 1;
      return false;
    },
    poke: () => {
      counts.pokes += 1;
    },
    ...overrides,
  };
  return { counts, poller: new QueuePoller(options) };
}

describe('QueuePoller', () => {
  test('runs the clock every turn and rings a bell when the queue has work', async () => {
    const { counts, poller } = rig({ hasClaimable: async () => true });
    poller.start();
    await Bun.sleep(80);
    await poller.stop();
    expect(counts.ticks).toBeGreaterThanOrEqual(3);
    expect(counts.pokes).toBeGreaterThanOrEqual(3);
  });

  test('reads nothing while the worker has no room, yet still runs the clock', async () => {
    const { counts, poller } = rig({ capacity: () => 0 });
    poller.start();
    await Bun.sleep(60);
    await poller.stop();
    expect(counts.probes).toBe(0);
    expect(counts.ticks).toBeGreaterThanOrEqual(2);
  });

  test('reads nothing while bells are still held, they will find the work', async () => {
    const { counts, poller } = rig({ drained: () => false });
    poller.start();
    await Bun.sleep(60);
    await poller.stop();
    expect(counts.probes).toBe(0);
  });

  test('backs off while the database is out of reach and recovers when it is back', async () => {
    let failing = true;
    const { counts, poller } = rig({
      hasClaimable: async () => {
        counts.probes += 1;
        if (failing) throw new Error('down');
        return false;
      },
    });
    poller.start();
    await Bun.sleep(300);
    const whileDown = counts.probes;
    failing = false;
    await Bun.sleep(300);
    await poller.stop();
    // 10 ms turns would be about 30 probes in 300 ms; doubling waits (capped at 8x) give about 7.
    expect(whileDown).toBeLessThan(12);
    expect(counts.probes - whileDown).toBeGreaterThan(whileDown);
  });

  test('a burst of requests for a turn is one extra turn', async () => {
    const { counts, poller } = rig({
      intervalMs: 10_000,
      hasClaimable: async () => {
        counts.probes += 1;
        await Bun.sleep(30);
        return false;
      },
    });
    poller.start();
    await Bun.sleep(10);
    for (let i = 0; i < 20; i += 1) poller.soon();
    await Bun.sleep(150);
    await poller.stop();
    expect(counts.probes).toBe(2);
  });

  test('stop waits for the turn in flight and then nothing else runs', async () => {
    let finished = false;
    const { counts, poller } = rig({
      hasClaimable: async () => {
        await Bun.sleep(40);
        finished = true;
        return true;
      },
    });
    poller.start();
    await Bun.sleep(10);
    await poller.stop();
    expect(finished).toBe(true);
    const pokes = counts.pokes;
    poller.soon();
    await Bun.sleep(50);
    expect(counts.pokes).toBe(pokes);
  });

  test('the jitter spreads the turns around the interval', async () => {
    const waits: number[] = [];
    let last = performance.now();
    const { poller } = rig({
      intervalMs: 40,
      jitter: 0.5,
      random: () => 1,
      tick: () => {
        const now = performance.now();
        waits.push(now - last);
        last = now;
      },
    });
    poller.start();
    await Bun.sleep(260);
    await poller.stop();
    // random() = 1 puts every wait at 1.5 x 40 = 60 ms: the first turn is immediate, the rest are not.
    expect(waits.slice(1).every((wait) => wait >= 55)).toBe(true);
  });
});
