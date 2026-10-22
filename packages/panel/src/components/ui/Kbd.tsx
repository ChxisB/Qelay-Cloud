import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Keyboard-shortcut chip (the "⌘K" in the search field): 12px mono on the slate tint, 8px radius. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded-kbd bg-slate-tint px-2 py-0.5 font-mono text-xs font-semibold text-muted',
        className
      )}
    >
      {children}
    </kbd>
  );
}
