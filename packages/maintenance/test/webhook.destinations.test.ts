import { describe, expect, test } from 'bun:test';
import type { Entry } from '../src/webhookDestinations';
import { Destinations } from '../src/webhookDestinations';
import { cachedResolver, sendDelivery } from '../src/webhookSend';
import { delivery, script } from './webhookSupport';

const LIMITS = { concurrency: 2, failures: 3, cooldownMs: 1_000 };

function destinations(limits = LIMITS) {
  let now = 0;
  return { dest: new Destinations(limits, () => now), advance: (ms: number) => (now += ms) };
}
const entered = async (dest: Destinations, key = 'a:443'): Promise<Entry> => {
  const entry = await dest.enter(key, 1_000);
  if (typeof entry === 'string') throw new Error(`refused: ${entry}`);
  return entry;
};

describe('destinations: concurrency', () => {
  test('a request past the limit waits for a slot, and gives up when its time is spent', async () => {
    const { dest } = destinations();
    const first = await entered(dest);
    await entered(dest);
    const third = dest.enter('a:443', 1_000);
    first.leave(true);
    expect(typeof (await third)).toBe('object');
    expect(await dest.enter('a:443', 20)).toBe('busy');
  });

  test('destinations do not share slots', async () => {
    const { dest } = destinations({ ...LIMITS, concurrency: 1 });
    await entered(dest, 'a:443');
    await entered(dest, 'b:443');
  });
});

describe('destinations: breaker', () => {
  const fail = async (dest: Destinations, times: number) => {
    for (let n = 0; n < times; n++) (await entered(dest)).leave(false);
  };

  test('opens after the failures in a row, lets one probe through after the cooldown', async () => {
    const { dest, advance } = destinations();
    await fail(dest, 3);
    expect(await dest.enter('a:443', 10)).toBe('open');
    advance(1_000);
    const probe = await entered(dest);
    expect(await dest.enter('a:443', 10)).toBe('open');
    probe.leave(false);
    expect(await dest.enter('a:443', 10)).toBe('open');
    advance(1_000);
    (await entered(dest)).leave(true);
    await entered(dest);
  });

  test('a good answer resets the count', async () => {
    const { dest } = destinations();
    await fail(dest, 2);
    (await entered(dest)).leave(true);
    await fail(dest, 2);
    await entered(dest);
  });

  test('failures 0 never opens it', async () => {
    const { dest } = destinations({ ...LIMITS, failures: 0 });
    await fail(dest, 20);
    await entered(dest);
  });
});

describe('cachedResolver', () => {
  test('one lookup per name inside the ttl, shared by concurrent callers, and a new one after it', async () => {
    let now = 0;
    const asked: string[] = [];
    const resolve = cachedResolver(
      async (host) => {
        asked.push(host);
        return ['93.184.216.34'];
      },
      1_000,
      () => now
    );
    await Promise.all([resolve('a.example'), resolve('a.example'), resolve('b.example')]);
    await resolve('a.example');
    expect(asked).toEqual(['a.example', 'b.example']);
    now = 1_000;
    await resolve('a.example');
    expect(asked).toEqual(['a.example', 'b.example', 'a.example']);
  });

  test('a failed lookup is not kept', async () => {
    let calls = 0;
    const resolve = cachedResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error('nxdomain');
      return ['93.184.216.34'];
    }, 1_000);
    await expect(Promise.resolve(resolve('a.example'))).rejects.toThrow('nxdomain');
    expect(await resolve('a.example')).toEqual(['93.184.216.34']);
  });
});

describe('sending through destinations', () => {
  test('a destination that failed enough is not connected to, and the refusal is a failed attempt', async () => {
    const { dest } = destinations({ ...LIMITS, failures: 2 });
    const sent = script({ post: () => ({ kind: 'status', status: 503 }) });
    const deps = sent.deps({ destinations: dest });
    for (let n = 0; n < 2; n++) await sendDelivery(delivery(), deps);
    expect(sent.calls).toHaveLength(2);
    const refused = await sendDelivery(delivery(), deps);
    expect(sent.calls).toHaveLength(2);
    expect(refused).toMatchObject({
      ok: false,
      statusCode: null,
      error: expect.stringContaining('paused'),
    });
    // Another destination is unaffected.
    const other = await sendDelivery(delivery({ url: 'https://other.example.com/in' }), deps);
    expect(other.statusCode).toBe(503);
    expect(sent.calls).toHaveLength(3);
  });

  test('a 4xx answer means the receiver is up: it does not count toward the breaker', async () => {
    const { dest } = destinations({ ...LIMITS, failures: 2 });
    const sent = script({ post: () => ({ kind: 'status', status: 410 }) });
    for (let n = 0; n < 5; n++) await sendDelivery(delivery(), sent.deps({ destinations: dest }));
    expect(sent.calls).toHaveLength(5);
  });
});
