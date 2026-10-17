import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Height assumed for a scroll area that reports none (a test DOM, or a hidden panel). */
const FALLBACK_VIEWPORT = 560;

export interface VirtualRows {
  readonly ref: React.RefObject<HTMLDivElement | null>;
  /** First and one past the last row to draw. */
  readonly start: number;
  readonly end: number;
  readonly totalHeight: number;
  readonly onScroll: () => void;
  /** Scroll just far enough that row `index` is in view. */
  readonly reveal: (index: number) => void;
}

/**
 * Which rows of a long list of fixed-height rows to draw: those in the scroll area, and a few either side.
 * A 5,000 job flow is a list of 5,000 rows but a screenful of elements.
 */
export function useVirtualRows(count: number, rowHeight: number, overscan: number): VirtualRows {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (ref.current) setScrollTop(ref.current.scrollTop);
  }, []);

  const reveal = useCallback(
    (index: number) => {
      const element = ref.current;
      if (!element || index < 0) return;
      const viewport = element.clientHeight || FALLBACK_VIEWPORT;
      const top = index * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + viewport)
        element.scrollTop = top + rowHeight - viewport;
      setScrollTop(element.scrollTop);
    },
    [rowHeight]
  );

  const viewport = height || FALLBACK_VIEWPORT;
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  return {
    ref,
    start: Math.max(0, Math.min(first - overscan, count)),
    end: Math.max(0, Math.min(last + overscan, count)),
    totalHeight: count * rowHeight,
    onScroll,
    reveal,
  };
}
