import { useEffect, useRef, useState } from 'react';
import { EXIT_MS, reducedMotion } from './usePresence';

export interface Leaver<T> {
  item: T;
  leaving: boolean;
}

/**
 * The list as given, plus each item that has just left for as long as its leave animation plays, in the place it
 * had. The list is for a stack that comes and goes (toasts); one surface that opens and closes uses `usePresence`.
 * Under reduced motion an item leaves at once.
 */
export function useLeavers<T extends { id: number | string }>(
  items: readonly T[]
): Array<Leaver<T>> {
  const [seen, setSeen] = useState(items);
  const [rows, setRows] = useState<Array<Leaver<T>>>(() =>
    items.map((item) => ({ item, leaving: false }))
  );

  if (items !== seen) {
    setSeen(items);
    const now = new Set(items.map((item) => item.id));
    const next: Array<Leaver<T>> = items.map((item) => ({ item, leaving: false }));
    // An item that left goes back into the slot it had, so a list that is sorted again still follows its new order.
    if (!reducedMotion()) {
      rows.forEach((row, at) => {
        if (!now.has(row.item.id))
          next.splice(Math.min(at, next.length), 0, { ...row, leaving: true });
      });
    }
    setRows(next);
  }

  // One timer per leaver, so a later leaver never holds an earlier one on screen past its own exit.
  const timed = useRef(new Set<number | string>());
  useEffect(() => {
    for (const { item, leaving } of rows) {
      if (!leaving || timed.current.has(item.id)) continue;
      timed.current.add(item.id);
      setTimeout(() => {
        timed.current.delete(item.id);
        setRows((now) => now.filter((row) => !(row.leaving && row.item.id === item.id)));
      }, EXIT_MS);
    }
  }, [rows]);

  return rows;
}
