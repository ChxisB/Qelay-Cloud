import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { main } from '../src/cli';

const ENV = { QCLOUD_DATABASE_URL: 'postgres://qcloud:x@127.0.0.1:1/qcloud' };

function capture() {
  const err: string[] = [];
  return { err, io: { out: () => {}, err: (line: string) => void err.push(line) } };
}

describe('qcloud-tick send', () => {
  test('runs the sender until it is stopped, then closes the store', async () => {
    let closed = 0;
    let claims = 0;
    const store = {
      webhooks: {
        writeDeliveries: async () => ({
          active: false,
          events: 0,
          written: 0,
          more: false,
          gap: false,
        }),
        claimDue: async () => {
          claims += 1;
          return [];
        },
      },
      close: async () => void (closed += 1),
    } as unknown as PostgresStore;
    const stop = new AbortController();
    const { io, err } = capture();
    const done = main(['send'], { ...ENV, QCLOUD_WEBHOOK_IDLE_MS: '10' }, io, {
      openStore: () => store,
      stopSignal: stop.signal,
    });
    await Bun.sleep(60);
    stop.abort();
    expect(await done).toBe(0);
    expect(claims).toBeGreaterThan(1);
    expect(closed).toBe(1);
    expect(err.join('\n')).toContain('sending webhooks');
  });

  test('a batch of 0 is a configuration error, not a sender that does nothing', async () => {
    const { io, err } = capture();
    expect(await main(['send'], { ...ENV, QCLOUD_WEBHOOK_BATCH: '0' }, io)).toBe(2);
    expect(err.join('\n')).toContain('QCLOUD_WEBHOOK_BATCH');
  });
});

describe('qcloud-tick webhook-writer', () => {
  const stateStore = (calls: string[]) =>
    ({
      webhooks: {
        startWriter: async () => (calls.push('on'), { mode: 'writer', commitSeq: 3, eventId: 1 }),
        stopWriter: async () => (
          calls.push('off'),
          { mode: 'trigger', commitSeq: null, eventId: null }
        ),
        writerState: async () => (
          calls.push('status'),
          { mode: 'trigger', commitSeq: null, eventId: null }
        ),
      },
      close: async () => {},
    }) as unknown as PostgresStore;

  test.each(['on', 'off', 'status'])(
    '%s calls the store and prints the state as JSON',
    async (action) => {
      const calls: string[] = [];
      const out: string[] = [];
      const io = { out: (line: string) => void out.push(line), err: () => {} };
      expect(
        await main(['webhook-writer', action], ENV, io, { openStore: () => stateStore(calls) })
      ).toBe(0);
      expect(calls).toEqual([action]);
      expect(JSON.parse(out.join(''))).toHaveProperty('mode');
    }
  );

  test('a missing or unknown action is a usage error', async () => {
    const { io } = capture();
    expect(await main(['webhook-writer'], ENV, io)).toBe(2);
    expect(await main(['webhook-writer', 'bogus'], ENV, io)).toBe(2);
  });
});
