import { useEffect, useState } from 'react';

/** Wall-clock time, re-read every `intervalMs`. Keep it in a small leaf so only that leaf re-renders. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
