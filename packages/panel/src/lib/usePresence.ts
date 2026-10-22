import { useEffect, useState } from 'react';

/** `--dur-exit` in tokens.css. */
export const EXIT_MS = 180;

export const reducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Keeps a surface mounted while it plays its leave animation. `mounted` says whether to render it,
 * `leaving` says to add the leave class. Under reduced motion it unmounts at once. It only delays
 * unmounting; the caller keeps handling Escape, focus and clicks from `open`, so nothing waits on it.
 */
export function usePresence(open: boolean): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const reduced = reducedMotion();

  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted, reduced]);

  // Opening and closing under reduced motion both take effect in the render itself.
  return { mounted: open || (mounted && !reduced), leaving: mounted && !open && !reduced };
}
