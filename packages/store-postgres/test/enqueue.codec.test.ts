import { describe, expect, test } from 'bun:test';
import { createMsgpackCodec } from '../src/codec';
import { createUuidV7 } from '../src/ids';

const codec = createMsgpackCodec();
const roundTrip = (value: unknown) => codec.decode(codec.encode(value));

describe('enqueue: payload codec', () => {
  test('Date, Map, Set and bigint survive, including a bigint over 64 bits', () => {
    const value = {
      when: new Date('2026-10-14T12:00:00.000Z'),
      map: new Map<unknown, unknown>([
        ['a', 1],
        [2, new Map([['nested', new Date(0)]])],
      ]),
      set: new Set([1, 'two', 3n]),
      small: 5n,
      negative: -123_456_789_012_345_678n,
      huge: 2n ** 100n + 7n,
      bytes: new Uint8Array([0, 1, 255]),
      nothing: null,
      list: [1, 'x', [true, undefined]],
    };
    const back = roundTrip(value) as typeof value;
    expect(back.when).toBeInstanceOf(Date);
    expect(back.when.getTime()).toBe(value.when.getTime());
    expect(back.map).toBeInstanceOf(Map);
    expect(back.map.get('a')).toBe(1);
    expect((back.map.get(2) as Map<string, Date>).get('nested')).toBeInstanceOf(Date);
    expect(back.set).toEqual(value.set);
    expect([back.small, back.negative, back.huge]).toEqual([
      5n,
      -123_456_789_012_345_678n,
      2n ** 100n + 7n,
    ]);
    expect(back.bytes).toEqual(value.bytes);
    expect(back.nothing).toBeNull();
    expect(back.list).toEqual(value.list);
  });

  test('a payload decodes with a decoder that never saw the encoder', () => {
    const bytes = createMsgpackCodec().encode({ id: 1, tags: ['a'], nested: { id: 2 } });
    expect(createMsgpackCodec().decode(bytes)).toEqual({ id: 1, tags: ['a'], nested: { id: 2 } });
  });

  test('the bytes are a copy: the next encode does not overwrite them', () => {
    const first = codec.encode({ n: 1 });
    const snapshot = [...first];
    codec.encode({ n: 2, padding: 'x'.repeat(100) });
    expect([...first]).toEqual(snapshot);
    expect(codec.decode(first)).toEqual({ n: 1 });
  });

  describe('a __proto__ key', () => {
    test('is an own property after the round trip, and the prototype is untouched', () => {
      const value = JSON.parse('{"__proto__": {"polluted": true}, "kept": 1}');
      const back = roundTrip(value) as Record<string, unknown>;
      expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
      expect(Object.keys(back).sort()).toEqual(['__proto__', 'kept']);
      expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toEqual({ polluted: true });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test('survives inside arrays, maps and nested objects', () => {
      const inner = JSON.parse('{"__proto__": 1}');
      const back = roundTrip({
        list: [inner],
        map: new Map([['k', inner]]),
        deep: { a: { b: inner } },
      }) as {
        list: Array<Record<string, unknown>>;
        map: Map<string, Record<string, unknown>>;
        deep: { a: { b: Record<string, unknown> } };
      };
      for (const found of [back.list[0]!, back.map.get('k')!, back.deep.a.b]) {
        expect(Object.getOwnPropertyDescriptor(found, '__proto__')?.value).toBe(1);
      }
    });

    test('a key that already starts with NUL keeps it, and the string value is not touched', () => {
      const value = JSON.parse('{"\\u0000__proto__": 1, "text": "__proto__"}');
      const back = roundTrip(value) as Record<string, unknown>;
      expect(Object.keys(back).sort()).toEqual(['\u0000__proto__', 'text']);
      expect(back['\u0000__proto__']).toBe(1);
      expect(back.text).toBe('__proto__');
    });

    test('a Map key named __proto__ is untouched', () => {
      const back = roundTrip(new Map([['__proto__', 1]])) as Map<string, number>;
      expect(back.get('__proto__')).toBe(1);
    });

    test('a payload without the marker is not rewritten', () => {
      const value = { a: new Date(1), b: new Map([['x', 1]]) };
      expect(codec.encode(value)).toEqual(createMsgpackCodec().encode(value));
    });
  });
});

describe('enqueue: job ids', () => {
  const uuid = (id: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

  test('are UUIDv7 and carry the time they were made at', () => {
    const ids = createUuidV7();
    const id = ids.next(1_800_000_000_000);
    expect(uuid(id)).toBe(true);
    expect(Number.parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(1_800_000_000_000);
  });

  test('sort in creation order, inside one millisecond and across a counter overflow', () => {
    const ids = createUuidV7();
    const made = Array.from({ length: 10_000 }, () => ids.next(1_800_000_000_000));
    expect(made.every(uuid)).toBe(true);
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });

  test('keep their order when the clock steps back, and follow it forward again', () => {
    const ids = createUuidV7();
    const a = ids.next(2_000);
    const b = ids.next(1_000);
    const c = ids.next(3_000);
    expect([a, b, c].sort()).toEqual([a, b, c]);
  });
});
