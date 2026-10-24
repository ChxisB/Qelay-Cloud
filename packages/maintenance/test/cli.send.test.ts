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
