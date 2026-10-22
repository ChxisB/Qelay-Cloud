import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Hides what most people do not need behind one line they can open. A native `<details>`, so the keyboard,
 * the screen reader and "find in page" all work without code; closed by default.
 */
export function Disclosure({
  summary,
  children,
  className,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={cn('group', className)} open={defaultOpen || undefined}>
      <summary
        className={cn(
          'flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-control text-[13px] font-bold text-fg',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden'
        )}
      >
        <span
          aria-hidden="true"
          className="text-xs text-muted transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {summary}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}
