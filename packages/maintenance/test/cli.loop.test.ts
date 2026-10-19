import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { CliRuntime } from '../src/cli';
import { main } from '../src/cli';

const ENV = { QCLOUD_DATABASE_URL: 'postgres://qcloud:x@127.0.0.1:1/qcloud' };

describe('qcloud-tick loop', () => {
  test('beats every second by default, upkeep every 30 s, and gives the lease up when stopped', async () => {
    const budgets: Array<{ skipUpkeep?: boolean; maxStaleRingsPerQueue?: number }> = [];
    const calls: string[] = [];
    let closed = 0;
    const store = {
      ringWindowMs: 0,
      tick: async (budget: { skipUpkeep?: boolean; maxStaleRingsPerQueue?: number }) => {
        budgets.push(budget);
        return { recovered: 0, promoted: 0, cronFired: 0, expired: 0, rings: [], moreWork: false };
      },
      metrics: { totals: async () => ({ completed: 0, failed: 0 }) },
      maintenance: {
        acquireTickLease: async (_holder: string, ttlMs: number) => (
          calls.push(`lease ${ttlMs}`),
          { held: true }
        ),
        recordTick: async () => {},
        releaseTickLease: async () => void calls.push('release'),
      },
      close: async () => void (closed += 1),
    } as unknown as PostgresStore;
    const runtime: CliRuntime = { store, transport: new MemoryTransport() };
    const stop = new AbortController();
    const err: string[] = [];
    const done = main(
      ['loop'],
      ENV,
      { out: () => {}, err: (line) => void err.push(line) },
      {
        open: () => runtime,
        stopSignal: stop.signal,
      }
    );
    await Bun.sleep(1_300);
    stop.abort();
    expect(await done).toBe(0);
    expect(budgets.length).toBeGreaterThanOrEqual(2);
    expect(budgets.map((b) => b.skipUpkeep === true).slice(0, 2)).toEqual([false, true]);
    expect(budgets[0]!.maxStaleRingsPerQueue).toBe(10);
    expect(calls[0]).toBe('lease 3000');
    expect(calls.at(-1)).toBe('release');
    expect(closed).toBe(1);
    expect(err.join('\n')).toContain('"message":"ticking"');
  });

  test('a setting from the environment wins over the loop defaults, and a bad one is a configuration error', async () => {
    const io = { out: () => {}, err: () => {} };
    expect(await main(['loop'], { ...ENV, QCLOUD_TICK_INTERVAL_MS: '0' }, io)).toBe(2);
    expect(await main(['loop', 'now'], ENV, io)).toBe(2);
  });
});
