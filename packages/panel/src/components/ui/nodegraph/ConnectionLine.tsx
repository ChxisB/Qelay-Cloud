import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import { type ConnectionState, WIRE_COLOUR, wireStyle } from './connectionState';

const PATTERN = {
  dashed: (deg: number) =>
    `repeating-linear-gradient(${deg}deg, currentColor 0 8px, transparent 8px 14px)`,
  dotted: (deg: number) =>
    `repeating-linear-gradient(${deg}deg, currentColor 0 2px, transparent 2px 7px)`,
};

/**
 * The line between a source and one destination, with whatever sits on it (the pill, rule glyphs) in the middle.
 * It runs into the 16px gaps of the grid on either side and ends in an arrow. It carries no action. It draws in
 * once on mount, `index` places it in the stagger. `vertical` runs it down a grid column, between rows, in the 16px row gaps. `pulse` is a count that moves only when something really
 * arrived (`useChangeFlash`): each move sends one comet along the line, and 0 sends none.
 */
export function ConnectionLine({
  state,
  index = 0,
  pulse = 0,
  vertical = false,
  tone,
  className,
  children,
}: {
  state: ConnectionState;
  index?: number;
  pulse?: number;
  vertical?: boolean;
  /** A text colour that stands in for the state's own (`cn` does not merge, so it cannot go in `className`). */
  tone?: string;
  className?: string;
  children?: ReactNode;
}) {
  const wire = wireStyle(state);
  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 items-center justify-center',
        tone ?? WIRE_COLOUR[state],
        className
      )}
    >
      <span
        aria-hidden="true"
        data-wire={wire}
        style={{
          ...stagger(index),
          ...(wire === 'solid' ? {} : { backgroundImage: PATTERN[wire](vertical ? 180 : 90) }),
        }}
        className={cn(
          'pointer-events-none absolute overflow-hidden rounded-sm',
          vertical
            ? 'motion-draw-y inset-y-[-16px] left-[calc(50%-1px)] w-0.5'
            : 'motion-draw inset-x-[-16px] top-[calc(50%-1px)] h-0.5',
          wire === 'solid' && 'bg-current'
        )}
      >
        {pulse > 0 && (
          <span
            key={pulse}
            className={cn('absolute inset-0', vertical ? 'motion-comet-y' : 'motion-comet')}
          />
        )}
      </span>
      <span
        aria-hidden="true"
        style={{
          clipPath: vertical ? 'polygon(0 0, 100% 0, 50% 100%)' : 'polygon(0 0, 100% 50%, 0 100%)',
        }}
        className={cn(
          'pointer-events-none absolute bg-current',
          vertical
            ? 'bottom-[-17px] left-[calc(50%-5px)] h-[9px] w-2.5'
            : 'top-[calc(50%-5px)] right-[-17px] h-2.5 w-[9px]'
        )}
      />
      <div className="relative z-10 flex max-w-full min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}
