import { useSyncExternalStore } from 'react';

/** True while the window is at least `px` wide; follows a resize. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener?.('change', notify);
      return () => list?.removeEventListener?.('change', notify);
    },
    () => !!window.matchMedia?.(query).matches
  );
}
