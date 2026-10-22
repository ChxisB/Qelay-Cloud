import { afterEach, describe, expect, test } from 'bun:test';
import { usePresence } from '../src/lib/usePresence';
import { renderHook, settle } from './domSetup';

// happy-dom plays no animations, so these check the state a surface passes through, with the real
// 180ms leave timer: still mounted and leaving just after close, gone after it, gone at once under
// reduced motion, and kept if it opens again before the timer ends.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

function reduceMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

describe('usePresence', () => {
  test('a closed surface is not mounted, an open one is on the first render', () => {
    reduceMotion(false);
    expect(renderHook(({ open }) => usePresence(open), { open: false }).result.current).toEqual({
      mounted: false,
      leaving: false,
    });
    expect(renderHook(({ open }) => usePresence(open), { open: true }).result.current).toEqual({
      mounted: true,
      leaving: false,
    });
  });

  test('closing keeps it mounted and leaving for the exit time, then unmounts', async () => {
    reduceMotion(false);
    const h = renderHook(({ open }) => usePresence(open), { open: true });
    h.rerender({ open: false });
    expect(h.result.current).toEqual({ mounted: true, leaving: true });

    await settle(60);
    expect(h.result.current).toEqual({ mounted: true, leaving: true });

    await settle(200);
    expect(h.result.current).toEqual({ mounted: false, leaving: false });
  });

  test('opening again while it leaves cancels the unmount', async () => {
    reduceMotion(false);
    const h = renderHook(({ open }) => usePresence(open), { open: true });
    h.rerender({ open: false });
    h.rerender({ open: true });
    expect(h.result.current).toEqual({ mounted: true, leaving: false });

    await settle(260);
    expect(h.result.current).toEqual({ mounted: true, leaving: false });
  });

  test('under reduced motion it unmounts at once', async () => {
    reduceMotion(true);
    const h = renderHook(({ open }) => usePresence(open), { open: true });
    h.rerender({ open: false });
    await settle(5);
    expect(h.result.current).toEqual({ mounted: false, leaving: false });
  });
});
