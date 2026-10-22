import { useEffect, useState } from 'react';

/**
 * True until the render after `ready` first holds, so a table can pass `arrive={first ? index : undefined}`:
 * the rows that come with the first load rise in a stagger, and rows a poll adds later do not.
 */
export function useFirstLoad(ready: boolean): boolean {
  const [first, setFirst] = useState(true);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the render that brings the rows must still read true, so this cannot be derived
    if (ready) setFirst(false);
  }, [ready]);
  return first;
}
