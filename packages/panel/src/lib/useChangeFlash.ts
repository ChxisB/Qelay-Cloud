import { useState } from 'react';

/**
 * A number that goes up each time `value` really changes, after the first read. Use it as a React key
 * on the figure, and add `motion-flash` only once it is above 0 (`<b key={flash} className={flash > 0 ? 'motion-flash' : ''}>`),
 * so the wash plays on a change and on nothing else: not on the first render, a poll that returns the
 * same value, or a re-render.
 */
export function useChangeFlash(value: unknown): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (!Object.is(seen.value, value)) setSeen({ value, count: seen.count + 1 });
  return seen.count;
}

/** Like `useChangeFlash`, but it counts only a rise: a total that went up since the last read. A fall or a first value counts nothing. */
export function useRises(value: number): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (!Object.is(value, seen.value))
    setSeen({ value, count: value > seen.value ? seen.count + 1 : seen.count });
  return seen.count;
}
