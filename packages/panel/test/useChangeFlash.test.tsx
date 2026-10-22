import { describe, expect, test } from 'bun:test';
import { useChangeFlash, useRises } from '../src/lib/useChangeFlash';
import { renderHook } from './domSetup';

// The flash restarts by React key, so what matters is when the key moves: on a real change after the
// first read, and never on the first render, an equal value or a re-render with the same one.

describe('useChangeFlash', () => {
  test('the first read does not flash', () => {
    expect(renderHook(({ v }) => useChangeFlash(v), { v: 3 }).result.current).toBe(0);
  });

  test('an unchanged value, even across re-renders, keeps the key', () => {
    const h = renderHook(({ v }) => useChangeFlash(v), { v: 3 });
    h.rerender({ v: 3 });
    h.rerender({ v: 3 });
    expect(h.result.current).toBe(0);
  });

  test('each real change moves the key once', () => {
    const h = renderHook(({ v }) => useChangeFlash(v), { v: 3 });
    h.rerender({ v: 4 });
    expect(h.result.current).toBe(1);
    h.rerender({ v: 4 });
    expect(h.result.current).toBe(1);
    h.rerender({ v: 3 });
    expect(h.result.current).toBe(2);
  });

  test('a value that goes from unknown to known counts as a change; NaN to NaN does not', () => {
    const h = renderHook(({ v }) => useChangeFlash(v), { v: undefined as number | undefined });
    h.rerender({ v: 7 });
    expect(h.result.current).toBe(1);
    const n = renderHook(({ v }) => useChangeFlash(v), { v: Number.NaN });
    n.rerender({ v: Number.NaN });
    expect(n.result.current).toBe(0);
  });

  test('a remount starts again at the first read', () => {
    const first = renderHook(({ v }) => useChangeFlash(v), { v: 1 });
    first.rerender({ v: 2 });
    first.unmount();
    expect(renderHook(({ v }) => useChangeFlash(v), { v: 2 }).result.current).toBe(0);
  });
});

describe('useRises', () => {
  test('counts only a rise, never the first read, a fall or an equal value', () => {
    const h = renderHook(({ v }) => useRises(v), { v: 5 });
    expect(h.result.current).toBe(0);
    h.rerender({ v: 5 });
    expect(h.result.current).toBe(0);
    h.rerender({ v: 3 });
    expect(h.result.current).toBe(0);
    h.rerender({ v: 4 });
    expect(h.result.current).toBe(1);
    h.rerender({ v: 4 });
    expect(h.result.current).toBe(1);
    h.rerender({ v: 9 });
    expect(h.result.current).toBe(2);
  });

  test('a total that is NaN does not loop, and counts nothing', () => {
    const h = renderHook(({ v }) => useRises(v), { v: Number.NaN });
    h.rerender({ v: Number.NaN });
    expect(h.result.current).toBe(0);
  });
});
