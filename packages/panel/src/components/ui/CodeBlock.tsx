import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * The design's code block: always dark, on the `log-*` tokens, like the log viewer.
 * It scrolls, so it is a named region and a tab stop: a scroller the keyboard cannot reach
 * cannot be read.
 */
export function CodeBlock({
  label,
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<'pre'>, 'role' | 'tabIndex' | 'aria-label'> & {
  /** Accessible name of the region, e.g. "Payload". */
  label: string;
  tone?: 'default' | 'error';
}) {
  return (
    <pre
      role="region"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll area must take the keyboard
      tabIndex={0}
      className={cn(
        'm-0 max-h-80 overflow-auto rounded-control bg-log-bg px-3.5 py-3 font-mono text-xs leading-[1.65]',
        tone === 'error' ? 'text-log-err' : 'text-log-fg',
        className
      )}
      {...props}
    />
  );
}
