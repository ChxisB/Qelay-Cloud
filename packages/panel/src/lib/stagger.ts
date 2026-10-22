import type { CSSProperties } from 'react';

/** A list item's place for the `motion-stagger`, `motion-draw` and `motion-arrive` delays (see motion.css). */
export const stagger = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties;
