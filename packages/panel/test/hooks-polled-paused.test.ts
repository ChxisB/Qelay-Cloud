import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { usePolledData } from '../src/lib/usePolledData';
import { renderHook, settle } from './domSetup';

const INTERVAL = 20;

describe('usePolledData paused', () => {
  test('a paused hook still loads once, then skips interval ticks until resumed', async () => {
    let calls = 0;
    const h = renderHook(
      (paused: boolean) =>
        usePolledData(
          async () => {
            calls += 1;
            return { n: calls };
          },
          [],
          { intervalMs: INTERVAL, paused }
        ),
      true
    );
    await settle(INTERVAL * 5);
    // The first load is never withheld, or a page opened while paused would stay empty.
    expect(h.result.current.data).toEqual({ n: 1 });
    expect(calls).toBe(1);

    h.rerender(false);
    await settle(INTERVAL * 4);
    expect(calls).toBeGreaterThanOrEqual(2);
    h.unmount();
  });

  test('pausing stops polling and an explicit refetch still runs', async () => {
    let calls = 0;
    const h = renderHook(
      (paused: boolean) =>
        usePolledData(
          async () => {
            calls += 1;
            return { n: calls };
          },
          [],
          { intervalMs: INTERVAL, paused }
        ),
      false
    );
    await settle(INTERVAL * 3);
    h.rerender(true);
    await settle(INTERVAL * 2); // let an in-flight tick drain
    const frozenAt = calls;
    await settle(INTERVAL * 6);
    expect(calls).toBe(frozenAt);

    await settle(0);
    await act(async () => {
      await h.result.current.refetch();
    });
    expect(calls).toBe(frozenAt + 1);
    h.unmount();
  });
});
