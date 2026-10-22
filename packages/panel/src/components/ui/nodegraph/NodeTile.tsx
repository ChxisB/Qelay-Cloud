import type { ComponentProps, ReactNode } from 'react';
import { NavIcon } from '@/components/layout/NavIcon';
import { cn } from '@/lib/cn';

/**
 * One node as a node editor draws it: a square tile with a glyph, the words under it, an input bar on the
 * left and an output dot on the right. The whole cell is one button. `tile` is the square's edge and `width`
 * the cell's, in pixels: the layout that places the cell and its lines uses the same two numbers.
 */
export function NodeTile({
  icon,
  tile,
  width,
  title,
  sub,
  note,
  badge,
  selected = false,
  danger = false,
  trigger = false,
  output = true,
  className,
  ...button
}: Omit<ComponentProps<'button'>, 'title'> & {
  /** SVG path of the glyph on the tile. */
  icon: string;
  tile: number;
  width: number;
  title: ReactNode;
  sub?: ReactNode;
  note?: ReactNode;
  /** A state glyph on the tile's top right corner. */
  badge?: ReactNode;
  selected?: boolean;
  /** The node needs a person: its border is the failure colour. */
  danger?: boolean;
  /** The node starts the chain: round on the left, no input bar. */
  trigger?: boolean;
  /** Draw the output dot. */
  output?: boolean;
}) {
  return (
    <button
      type="button"
      style={{ width }}
      className={cn(
        'group flex flex-col items-center gap-1.5 rounded-control text-center',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className
      )}
      {...button}
    >
      <span className="relative block" style={{ width: tile, height: tile }}>
        <span
          className={cn(
            'absolute inset-0 grid place-items-center border-2 bg-surface shadow-panel transition-colors group-hover:bg-surface-2',
            trigger ? 'rounded-[18%] rounded-l-[50%]' : 'rounded-[18%]',
            selected ? 'border-hl ring-2 ring-hl' : danger ? 'border-danger' : 'border-line-strong'
          )}
        >
          <NavIcon d={icon} className="size-8 text-fg" />
        </span>
        {!trigger && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 -left-[3px] h-3.5 w-[5px] -translate-y-1/2 rounded-[2px] bg-faint"
          />
        )}
        {output && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 rounded-full bg-faint"
          />
        )}
        {badge && (
          <span className="absolute -top-1.5 -right-1.5 grid size-[18px] place-items-center rounded-full bg-surface">
            {badge}
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 flex-col px-1">
        <span className="truncate text-sm leading-[18px] font-semibold text-fg">{title}</span>
        {sub && <span className="truncate text-xs leading-4 text-muted">{sub}</span>}
        {note && <span className="truncate text-xs leading-4 text-muted">{note}</span>}
      </span>
    </button>
  );
}
