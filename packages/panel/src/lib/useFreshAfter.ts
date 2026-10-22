import { useState } from 'react';

/**
 * For a list that grows at the head, newest first, numbered upwards (`seq`): the head's number from before its latest
 * change. Entries above it came in with that change, so they are the ones to animate. A render that changes nothing
 * (a filter, a re-render, a paused view) leaves it where it was, and a list that is already there when the page opens
 * has nothing above it. `undefined` is an empty list, so its first entries are all new.
 */
export function useFreshAfter(head: number | undefined): number {
  const [seen, setSeen] = useState({ head, before: head });
  if (seen.head !== head) setSeen({ head, before: seen.head });
  return seen.before ?? Number.NEGATIVE_INFINITY;
}
