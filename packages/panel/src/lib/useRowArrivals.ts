import { useEffect, useState } from 'react';

/**
 * Where each row of a polled list rises as it mounts, for `Tr`'s `arrive`: the first load in a stagger, an id that
 * a later read of the same list adds once (place 0), and nothing for a list the person changed (`key` names the
 * filter and page, so another one just appears). `ids` is the whole read, not what a local filter leaves, so a row
 * that a search hides and shows again is not new. `ready` is false while the read is loading.
 */
export function useRowArrivals(
  key: string,
  ids: readonly string[],
  ready: boolean
): (id: string, index: number) => number | undefined {
  const [known, setKnown] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null);
  const joined = ids.join('\n');
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the render that brings the rows must still read the old list
    if (ready) setKnown({ key, ids: new Set(joined === '' ? [] : joined.split('\n')) });
  }, [ready, key, joined]);
  return (id, index) => {
    if (known === null) return index;
    return known.key === key && !known.ids.has(id) ? 0 : undefined;
  };
}
