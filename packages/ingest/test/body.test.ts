import { describe, expect, test } from 'bun:test';
import { readBody } from '../src/body';
import { MinuteLimiter } from '../src/rateLimit';
import { chunks, hang } from './support';

const request = (body: RequestInit['body']) =>
  new Request('http://ingest.test/', {
    method: 'POST',
    ...(body === null ? {} : { body, duplex: 'half' }),
  } as RequestInit);

describe('readBody', () => {
  test('returns what arrived, empty for no body', async () => {
    expect(await readBody(request(null), 10, 1_000)).toEqual({
      kind: 'ok',
      body: new Uint8Array(0),
    });
    const read = await readBody(request('hello'), 10, 1_000);
    expect(read.kind === 'ok' && new TextDecoder().decode(read.body)).toBe('hello');
  });

  test('takes a body of exactly the cap, and refuses one byte more', async () => {
    expect((await readBody(request(chunks(2, 5)), 10, 1_000)).kind).toBe('ok');
    expect((await readBody(request(chunks(3, 4)), 10, 1_000)).kind).toBe('too_large');
  });

  test('stops reading at the cap however long the stream would go on', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    expect((await readBody(request(endless), 4_096, 1_000)).kind).toBe('too_large');
    expect(pulled).toBeLessThan(20);
  });

  test('gives up on a body that does not arrive in time', async () => {
    const started = Date.now();
    expect((await readBody(request(hang()), 10, 50)).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a stream that breaks is not a request', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('reset'));
      },
    });
    expect((await readBody(request(broken), 10, 1_000)).kind).toBe('timeout');
  });
});

describe('MinuteLimiter', () => {
  test('lets `limit` calls through a minute, then says how long to wait', () => {
    let now = 60_000 * 10 + 15_000;
    const limiter = new MinuteLimiter(2, () => now);
    expect([limiter.take('a'), limiter.take('a')]).toEqual([0, 0]);
    expect(limiter.take('a')).toBe(45);
    expect(limiter.take('b')).toBe(0);
    now += 44_000;
    expect(limiter.take('a')).toBe(1);
    now += 1_000;
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([0, 0, 60]);
  });
});
