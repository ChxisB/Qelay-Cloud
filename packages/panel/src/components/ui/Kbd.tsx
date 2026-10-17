import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Keyboard-shortcut chip (the "⌘K" in the search field): 11px mono, 1px border, 6px radius. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded-kbd border border-line-strong px-1.5 py-px font-mono text-[11px] text-muted',
        className
      )}
    >
      {children}
    </kbd>
  );
}
