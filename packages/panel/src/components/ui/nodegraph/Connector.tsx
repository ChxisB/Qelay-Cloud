import { stagger } from '@/lib/stagger';
import type { WireStyle } from './connectionState';

const ARROW = 6;
const DASH: Record<WireStyle, string | undefined> = {
  solid: undefined,
  dashed: '6 5',
  dotted: '2 5',
};

/** Where an arrow's tip meets the input bar of a tile: the bar sticks out this far from the tile's edge. */
export const INPUT_REACH = 3;

/**
 * A line that leaves and enters flat, as in a node editor, ending in a small arrow that touches `(x2, y2)`.
 * Without `index` it is drawn as it always was. With one it draws in from its left end, once, at that place in
 * the stagger; `dash` is the state's pattern for a line that is held, stopped or off. `pulse` is a count that
 * goes up when the thing at the line's end really changed (`useChangeFlash`): each step draws the line once more.
 * An SVG line cannot carry the HTML comet, and only `transform` and `opacity` may move, so it is the draw again.
 */
export function Connector({
  x1,
  y1,
  x2,
  y2,
  danger = false,
  index,
  dash = 'solid',
  pulse = 0,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  danger?: boolean;
  index?: number;
  dash?: WireStyle;
  pulse?: number;
}) {
  const reach = Math.abs(x2 - x1) / 2;
  const end = x2 - ARROW;
  return (
    <g
      key={pulse}
      {...(index === undefined && pulse === 0
        ? {}
        : { className: 'motion-draw', style: index === undefined ? undefined : stagger(index) })}
    >
      <path
        d={`M${x1} ${y1} C${x1 + reach} ${y1} ${end - reach} ${y2} ${end} ${y2}`}
        fill="none"
        strokeWidth={2}
        strokeDasharray={DASH[dash]}
        className={danger ? 'stroke-danger' : 'stroke-faint'}
      />
      <path
        d={`M${end} ${y2 - 4}L${x2} ${y2}L${end} ${y2 + 4}z`}
        className={danger ? 'fill-danger' : 'fill-faint'}
      />
    </g>
  );
}
