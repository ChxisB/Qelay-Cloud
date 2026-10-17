import { describe, expect, test } from 'bun:test';
import { decode, encodeBell, encodeHeartbeat, MAX_NOTIFY_BYTES } from '../src/wire';

const bell = { namespace: 'ns', queue: 'q', jobId: 'job-1' };

describe('wire codec', () => {
  test('a bell survives the round trip, with its delay', () => {
    expect(decode(encodeBell(bell, 1_500)!)).toEqual({ kind: 'bell', bell, delayMs: 1_500 });
  });

  test('a bell without a job id or a delay is the short form', () => {
    const payload = encodeBell({ namespace: 'ns', queue: 'q' }, 0)!;
    expect(JSON.parse(payload)).toEqual({ n: 'ns', q: 'q' });
    expect(decode(payload)).toEqual({
      kind: 'bell',
      bell: { namespace: 'ns', queue: 'q' },
      delayMs: 0,
    });
  });

  test('a job id too long for the limit is dropped and the bell still fits', () => {
    const payload = encodeBell({ ...bell, jobId: 'x'.repeat(MAX_NOTIFY_BYTES) }, 0)!;
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_NOTIFY_BYTES);
    expect(decode(payload)).toMatchObject({ bell: { namespace: 'ns', queue: 'q' } });
    expect(JSON.parse(payload).j).toBeUndefined();
  });

  test('a queue name too long for the limit cannot be sent', () => {
    expect(encodeBell({ namespace: 'ns', queue: 'q'.repeat(MAX_NOTIFY_BYTES) }, 0)).toBeNull();
  });

  test('counts bytes, not characters', () => {
    const wide = '€'.repeat(2_700);
    const payload = encodeBell({ ...bell, jobId: wide }, 0)!;
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_NOTIFY_BYTES);
    expect(JSON.parse(payload).j).toBeUndefined();
  });

  test('a heartbeat survives the round trip', () => {
    expect(decode(encodeHeartbeat('abc', 7))).toEqual({
      kind: 'heartbeat',
      instance: 'abc',
      sequence: 7,
    });
  });

  test.each([
    ['not json', 'hello'],
    ['a scalar', '42'],
    ['null', 'null'],
    ['an array', '[1, 2]'],
    ['an object of another shape', '{"x":1}'],
    ['a bell without a queue', '{"n":"ns"}'],
    ['a queue that is not a string', '{"n":"ns","q":5}'],
  ])('ignores %s', (_name, payload) => {
    expect(decode(payload)).toBeNull();
  });

  test('a bad delay or job id is read as absent, not as an error', () => {
    expect(decode('{"n":"ns","q":"q","d":-5,"j":7}')).toEqual({
      kind: 'bell',
      bell: { namespace: 'ns', queue: 'q' },
      delayMs: 0,
    });
  });
});
