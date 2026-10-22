import { describe, expect, test } from 'bun:test';
import { useLeavers } from '../src/lib/useLeavers';
import { renderHook, settle } from './domSetup';

// Each item that leaves plays its own 180ms exit; one leaving later does not hold the earlier one on screen.

const a = { id: 'a' };
const b = { id: 'b' };
const c = { id: 'c' };

describe('useLeavers', () => {
  test('an item that left earlier is gone on its own time, not when the next one has left', async () => {
    const h = renderHook(({ items }) => useLeavers(items), { items: [a, b, c] });
    h.rerender({ items: [b, c] });
    expect(h.result.current.map((row) => [row.item.id, row.leaving])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
    await settle(120);
    h.rerender({ items: [c] });
    await settle(120);
    // 240ms in: a (due at 180) is gone, b (due at 300) is still leaving.
    expect(h.result.current.map((row) => [row.item.id, row.leaving])).toEqual([
      ['b', true],
      ['c', false],
    ]);
    await settle(120);
    expect(h.result.current.map((row) => row.item.id)).toEqual(['c']);
    h.unmount();
  });
});
