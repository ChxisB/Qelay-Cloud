import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { NAV_GROUPS_STORAGE_KEY, useNavGroups } from '../src/lib/useNavGroups';
import { renderHook } from './domSetup';

beforeEach(() => localStorage.removeItem(NAV_GROUPS_STORAGE_KEY));
afterEach(() => localStorage.removeItem(NAV_GROUPS_STORAGE_KEY));

describe('useNavGroups', () => {
  test('opens only Work by default', () => {
    const hook = renderHook(() => useNavGroups(null, '/'));
    expect(hook.result.current.isOpen('Work')).toBe(true);
    expect(hook.result.current.isOpen('Monitor')).toBe(false);
    expect(hook.result.current.isOpen('Automation')).toBe(false);
    hook.unmount();
  });

  test('the group holding the current route is open on load', () => {
    const hook = renderHook(() => useNavGroups('System', '/settings'));
    expect(hook.result.current.isOpen('System')).toBe(true);
    hook.unmount();
  });

  test('navigating into a collapsed group opens it, even over a saved collapse', () => {
    localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify({ Monitor: false }));
    const hook = renderHook(
      ({ section, path }: { section: string | null; path: string }) => useNavGroups(section, path),
      { section: 'Work', path: '/jobs' }
    );
    expect(hook.result.current.isOpen('Monitor')).toBe(false);
    hook.rerender({ section: 'Monitor', path: '/metrics' });
    expect(hook.result.current.isOpen('Monitor')).toBe(true);
    hook.unmount();
  });

  test('a toggle persists, and the viewer can collapse the active group', () => {
    const hook = renderHook(() => useNavGroups('Work', '/jobs'));
    act(() => hook.result.current.toggle('Work'));
    expect(hook.result.current.isOpen('Work')).toBe(false);
    expect(JSON.parse(localStorage.getItem(NAV_GROUPS_STORAGE_KEY) ?? '{}')).toEqual({
      Work: false,
    });
    act(() => hook.result.current.toggle('Automation'));
    expect(hook.result.current.isOpen('Automation')).toBe(true);
    hook.unmount();

    // A fresh mount elsewhere restores the saved choices.
    const next = renderHook(() => useNavGroups(null, '/'));
    expect(next.result.current.isOpen('Work')).toBe(false);
    expect(next.result.current.isOpen('Automation')).toBe(true);
    next.unmount();
  });

  test('a navigation-forced open is not written to storage', () => {
    const hook = renderHook(() => useNavGroups('Monitor', '/metrics'));
    expect(hook.result.current.isOpen('Monitor')).toBe(true);
    expect(localStorage.getItem(NAV_GROUPS_STORAGE_KEY)).toBeNull();
    hook.unmount();
  });

  test('corrupt or foreign stored values fall back to the defaults', () => {
    for (const bad of ['not json', '[]', '"x"', '{"Work":"yes"}']) {
      localStorage.setItem(NAV_GROUPS_STORAGE_KEY, bad);
      const hook = renderHook(() => useNavGroups(null, '/'));
      expect(hook.result.current.isOpen('Work')).toBe(true);
      expect(hook.result.current.isOpen('Automation')).toBe(false);
      hook.unmount();
    }
  });

  test('toggling still works when storage throws', () => {
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('quota');
    };
    try {
      const hook = renderHook(() => useNavGroups(null, '/'));
      act(() => hook.result.current.toggle('Automation'));
      expect(hook.result.current.isOpen('Automation')).toBe(true);
      hook.unmount();
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});
