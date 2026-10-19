import { expect, test } from 'bun:test';
import { overShape } from '../src/store/payloadShape';

const limits = { maxPayloadNodes: 100, maxPayloadDepth: 8 };

test('a value within both limits passes, whatever its encoded size', () => {
  expect(
    overShape({ a: [1, 2, { b: null }], c: new Map([['k', new Set([1])]]) }, limits)
  ).toBeNull();
  expect(overShape(new Uint8Array(1_000_000), limits)).toBeNull();
});

test('values and object keys count toward the node limit, and the first breach is named', () => {
  expect(
    overShape(
      Array.from({ length: 99 }, () => null),
      limits
    )
  ).toBeNull();
  expect(
    overShape(
      Array.from({ length: 99 }, () => null),
      { ...limits, maxPayloadNodes: 99 }
    )
  ).toEqual({ kind: 'nodes', limit: 99 });
  const keyed = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`k${n}`, n]));
  expect(overShape(keyed, limits)).toEqual({ kind: 'nodes', limit: 100 });
  expect(overShape([[[[[[[[[1]]]]]]]]], limits)).toEqual({ kind: 'depth', limit: 8 });
});

test('a value a million levels deep and a cycle are refused, not walked to the end', () => {
  let deep: unknown[] = [];
  for (let n = 0; n < 1_000_000; n++) deep = [deep];
  expect(overShape(deep, limits)?.kind).toBe('depth');
  const loop: unknown[] = [];
  loop.push(loop, loop);
  expect(overShape(loop, { ...limits, maxPayloadDepth: 1_000_000 })?.kind).toBe('nodes');
});
