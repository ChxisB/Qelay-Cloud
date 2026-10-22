import { type ComponentProps, useState } from 'react';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';

export type RowStatus = 'bad' | 'warn' | 'active' | 'idle';

// One vocabulary for every table. Hover is the neutral wash. Selected is the coral wash plus a 3px
// bar. A status is the bar alone, so a status never looks like a hover. The bar is drawn on the
// first cell (a `tr` cannot carry a shadow in every browser); the row only sets `--rc` and `--row-bg`.
const IDLE_ROW = '[--rc:transparent] [--row-bg:transparent]';
const SELECTED_ROW = '[--rc:var(--hl)] [--row-bg:var(--selected)]';
const STATUS_ROW: Record<RowStatus, string> = {
  bad: '[--rc:var(--bad)] [--row-bg:transparent]',
  warn: '[--rc:var(--warn)] [--row-bg:transparent]',
  active: '[--rc:var(--active)] [--row-bg:transparent]',
  idle: '[--rc:var(--idle)] [--row-bg:transparent]',
};

/**
 * Horizontal scroll for a wide table. The row bar is inset in the first cell, so it needs no gutter.
 * `relative` keeps an `sr-only` (absolutely placed) label inside the scroller: otherwise it sits
 * outside the clip and widens the page. `tabIndex` lets a keyboard user scroll it when no cell is a
 * link or button (axe `scrollable-region-focusable`).
 * shortcut: always a tab stop, even for a table that fits; upgrade to focusable-only-when-overflowing
 * (a ResizeObserver on scrollWidth) if the extra stops are a complaint.
 */
export function TableScroll({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll area must take the keyboard
      tabIndex={0}
      className={cn('relative overflow-x-auto', className)}
      {...props}
    />
  );
}

/** A real `<table>`, so header cells stay associated with their columns for screen readers. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

/** `sticky` pins the header cells to the top of the nearest scrolling ancestor. */
export function THead({
  sticky = false,
  className,
  ...props
}: ComponentProps<'thead'> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        sticky && '[&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:bg-surface',
        className
      )}
      {...props}
    />
  );
}

// `cn` does not merge, so a cell never carries two padding utilities: `tight` swaps the side
// padding instead of a page overriding it (numeric columns on a phone).
const SIDE = 'px-3';
const SIDE_TIGHT = 'px-1.5 sm:px-3';

/** Column header. Pass `aria-sort` on a sortable one; `right` aligns a numeric column. */
export function Th({
  tight = false,
  right = false,
  className,
  scope = 'col',
  ...props
}: ComponentProps<'th'> & { tight?: boolean; right?: boolean }) {
  return (
    <th
      scope={scope}
      className={cn(
        'h-8 border-b border-line text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-faint uppercase',
        right ? 'text-right' : 'text-left',
        tight ? SIDE_TIGHT : SIDE,
        className
      )}
      {...props}
    />
  );
}

/**
 * `arrive` is the row's place in the first load (see `useFirstLoad`): it rises in a stagger. It is read once, at
 * mount: dropping the class later (the page stops passing it) would cut the rise short.
 */
export function Tr({
  status,
  selected = false,
  dense = false,
  arrive,
  className,
  style,
  ...props
}: ComponentProps<'tr'> & {
  status?: RowStatus;
  selected?: boolean;
  dense?: boolean;
  arrive?: number;
}) {
  const [place] = useState(arrive);
  return (
    <tr
      className={cn(
        'border-b border-line bg-(--row-bg) transition-colors duration-(--duration-hover) ease-settle last:border-b-0',
        'hover:bg-[linear-gradient(var(--hover),var(--hover))] [&>:first-child]:shadow-[inset_3px_0_0_var(--rc)]',
        dense ? 'h-9' : 'h-10',
        selected ? SELECTED_ROW : status ? STATUS_ROW[status] : IDLE_ROW,
        place !== undefined && 'motion-arrive',
        className
      )}
      style={place === undefined ? style : { ...style, ...stagger(place) }}
      {...props}
    />
  );
}

export function Td({
  tight = false,
  className,
  ...props
}: ComponentProps<'td'> & { tight?: boolean }) {
  return (
    <td
      className={cn('min-w-0 py-1.5 align-middle text-fg', tight ? SIDE_TIGHT : SIDE, className)}
      {...props}
    />
  );
}
