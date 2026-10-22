import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { IconSearch } from './icons';
import { Kbd } from './Kbd';

/**
 * Text filter with a leading search icon and an optional trailing shortcut chip. The wrapper
 * owns the border and the focus ring (the bare input inside has none of its own). `className`
 * styles the input, `containerClassName` the wrapper, and every other prop reaches the input.
 */
export function SearchField({
  containerClassName,
  className,
  shortcut,
  ...props
}: ComponentProps<'input'> & {
  containerClassName?: string;
  /** Shortcut hint shown at the end of the field, e.g. "⌘K". */
  shortcut?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-8 min-w-0 items-center gap-2.5 rounded-control border border-line-strong bg-surface py-0 pl-4 pr-3 text-faint',
        'transition-colors',
        'focus-within:border-ring focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        containerClassName
      )}
    >
      <IconSearch className="size-4 shrink-0" />
      <input
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint',
          className
        )}
        {...props}
      />
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </div>
  );
}
