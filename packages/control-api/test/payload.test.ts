import { describe, expect, test } from 'bun:test';
import { createMsgpackCodec } from '@qelay-cloud/store-postgres';
import type { ApiError } from '../src';
import { fromWire, toWire } from '../src/jobs/payload';

const BIG = { maxBytes: 1_000_000 };

/** Through the codec the store uses, then the wire, then JSON text, then back. */
function roundTrip(value: unknown): unknown {
  const codec = createMsgpackCodec();
  const stored = codec.decode(codec.encode(value));
  const { value: wire, truncated } = toWire(stored, BIG);
  expect(truncated).toBe(false);
  return fromWire(JSON.parse(JSON.stringify(wire)));
}

describe('toWire and fromWire', () => {
  test('plain JSON is unchanged', () => {
    const value = { a: 1, b: ['x', null, true], c: { d: 'e' }, f: 1.5 };
    expect(toWire(value, BIG)).toEqual({ value, truncated: false });
    expect(roundTrip(value)).toEqual(value);
  });

  test('a bigint is a tagged decimal string, and comes back as a bigint', () => {
    const wire = toWire({ n: 9_007_199_254_740_993n }, BIG).value;
    expect(wire).toEqual({ n: { $type: 'bigint', value: '9007199254740993' } });
    expect(roundTrip({ n: -12n })).toEqual({ n: -12n });
  });

  test('a Date is an ISO string, and an invalid one stays invalid', () => {
    const when = new Date('2026-10-15T08:30:00.123Z');
    expect(toWire(when, BIG).value).toEqual({ $type: 'date', value: '2026-10-15T08:30:00.123Z' });
    expect(roundTrip({ when })).toEqual({ when });
    const invalid = roundTrip(new Date(Number.NaN)) as Date;
    expect(Number.isNaN(invalid.getTime())).toBe(true);
  });

  test('bytes are base64 and come back as a Uint8Array', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(toWire(bytes, BIG).value).toEqual({ $type: 'bytes', base64: 'AAH+/w==' });
    expect(roundTrip({ bytes })).toEqual({ bytes });
  });

  test('a Map and a Set keep their entries, including keys that are not strings', () => {
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [2, new Set([1n, 'x'])],
    ]);
    expect(roundTrip({ map })).toEqual({ map });
  });

  test('NaN and the infinities are tagged, and undefined survives', () => {
    const value = { a: Number.NaN, b: Number.POSITIVE_INFINITY, d: undefined, e: [undefined] };
    const back = roundTrip(value) as typeof value;
    expect(Number.isNaN(back.a)).toBe(true);
    expect(back.b).toBe(Number.POSITIVE_INFINITY);
    expect(Object.hasOwn(back, 'd')).toBe(true);
    expect(back.e).toEqual([undefined]);
  });

  test('negative zero is tagged by the wire itself (the store codec stores it as 0)', () => {
    const { value } = toWire(-0, BIG);
    expect(value).toEqual({ $type: 'number', value: '-0' });
    expect(Object.is(fromWire(value), -0)).toBe(true);
  });

  test('a payload object that has its own $type key is wrapped, so it is never taken for a tag', () => {
    const value = { $type: 'bigint', value: 'not a number' };
    const wire = toWire(value, BIG).value;
    expect(wire).toEqual({ $type: 'object', value });
    expect(roundTrip(value)).toEqual(value);
  });

  test('a key named __proto__ is data, not a prototype', () => {
    const value = JSON.parse('{"__proto__": {"admin": true}, "x": 1}') as object;
    const back = roundTrip(value) as Record<string, unknown>;
    expect(Object.hasOwn(back, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
  });

  test('a value nested deeper than the limit is cut with a depth tag, not a stack overflow', () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 5_000; level += 1) deep = [deep];
    const { value } = toWire(deep, BIG);
    expect(JSON.stringify(value)).toContain('"$type":"depth"');
  });
});

describe('truncation', () => {
  test('a long string becomes a marker with its length and the start of it', () => {
    const { value, truncated } = toWire('x'.repeat(10_000), { maxBytes: 1_000 });
    expect(truncated).toBe(true);
    expect(value).toEqual({
      $type: 'truncated',
      kind: 'string',
      length: 10_000,
      preview: 'x'.repeat(200),
      maxBytes: 1_000,
    });
  });

  test('a large array is a marker with its length, and visiting stops at the budget', () => {
    let visited = 0;
    const items = new Proxy(
      Array.from({ length: 1_000_000 }, (_, index) => index),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) visited += 1;
          return Reflect.get(target, key, receiver);
        },
      }
    );
    const { value, truncated } = toWire(items, { maxBytes: 4_000 });
    expect(truncated).toBe(true);
    expect(value).toMatchObject({ $type: 'truncated', kind: 'array', length: 1_000_000 });
    expect(visited).toBeLessThan(10_000);
  });

  test('an object is a marker with its key count; a payload that fits is not marked', () => {
    const big = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`key${i}`, 'v'.repeat(50)])
    );
    expect(toWire(big, { maxBytes: 2_000 })).toMatchObject({
      truncated: true,
      value: { $type: 'truncated', kind: 'object', length: 500 },
    });
    expect(toWire({ small: 1 }, { maxBytes: 2_000 }).truncated).toBe(false);
  });

  test('the encoded form of what fits stays under the budget', () => {
    const value = { rows: Array.from({ length: 50 }, (_, i) => ({ i, text: 'abc'.repeat(10) })) };
    const { value: wire, truncated } = toWire(value, { maxBytes: 8_000 });
    expect(truncated).toBe(false);
    expect(JSON.stringify(wire).length).toBeLessThanOrEqual(8_000);
  });
});

describe('fromWire refuses what it must not save', () => {
  const refused = (wire: unknown): ApiError => {
    try {
      fromWire(wire);
    } catch (error) {
      return error as ApiError;
    }
    throw new Error('expected a refusal');
  };

  test('a truncated marker is a 400: a payload cut for display is never written back', () => {
    const error = refused({ a: { $type: 'truncated', kind: 'string', length: 9 } });
    expect([error.status, error.code]).toEqual([400, 'invalid_request']);
    expect(error.message).toContain('truncated');
  });

  test('an unknown tag, a malformed tag and an over-deep payload are 400s', () => {
    for (const wire of [
      { $type: 'regexp', value: 'x' },
      { $type: 'bigint', value: 'abc' },
      { $type: 'date', value: 'yesterday' },
      { $type: 'map', entries: [[1]] },
      { $type: 'number', value: '12' },
      { $type: 'unsupported', kind: 'function' },
    ]) {
      expect(refused(wire).status).toBe(400);
    }
    let deep: unknown = 1;
    for (let level = 0; level < 200; level += 1) deep = { next: deep };
    expect(refused(deep).status).toBe(400);
  });

  test('a rejection never repeats the payload', () => {
    const error = refused({ $type: 'bigint', value: 'secret-token-123' });
    expect(JSON.stringify(error.message)).not.toContain('secret-token-123');
  });
});
