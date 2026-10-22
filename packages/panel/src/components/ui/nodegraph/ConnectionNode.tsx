import { Link, type LinkProps } from 'react-router-dom';
import { NavIcon } from '@/components/layout/NavIcon';
import { cn } from '@/lib/cn';
import type { ConnectionState } from './connectionState';

export type NodeKind = 'source' | 'http' | 'queue' | 'cron' | 'other';

// The icon box takes the tint pair of a state that already exists; no tint of its own.
const TINT: Record<NodeKind, string> = {
  source: 'bg-slate-tint text-fg',
  http: 'bg-state-active-bg text-state-active-fg',
  queue: 'bg-state-waiting-bg text-state-waiting-fg',
  cron: 'bg-state-completed-bg text-state-completed-fg',
  other: 'bg-state-delayed-bg text-fg',
};

// A held, stopped or disabled connection leaves its end node as an outline: dashed, dashed in red, dotted.
const OUTLINE: Record<ConnectionState, string> = {
  active: 'border-solid border-line-strong bg-bg',
  held: 'border-dashed border-line-strong bg-transparent',
  paused: 'border-dashed border-bad bg-transparent',
  off: 'border-dotted border-line-strong bg-transparent',
};

/**
 * One end of a connection, drawn in HTML so a name can truncate and a row can lay it out in a grid:
 * an icon in a tinted box, a bold name, one line under it. `to` makes it a link. The full name stays in
 * the text and in `title` when the box clips it. SVG canvases use `NodeTile` instead.
 */
export function ConnectionNode({
  kind,
  icon,
  name,
  sub,
  state = 'active',
  placeholder = false,
  to,
  className,
}: {
  kind: NodeKind;
  /** SVG path of the glyph, on the 24px grid of `NavIcon`. */
  icon: string;
  name: string;
  sub?: string;
  state?: ConnectionState;
  /** An end not chosen yet: a dashed outline and a muted name that says what is missing. */
  placeholder?: boolean;
  to?: LinkProps['to'];
  className?: string;
}) {
  const classes = cn(
    'flex min-h-15 min-w-0 items-center gap-3 rounded-[20px] border-[1.5px] py-2.5 pr-3.5 pl-2.5',
    'transition-[border-color,background-color,color] duration-(--duration-hover) ease-settle',
    placeholder ? 'border-dashed border-line-strong bg-transparent' : OUTLINE[state],
    to && 'hover:border-muted',
    className
  );
  const body = (
    <>
      <span className={cn('grid size-10 flex-none place-items-center rounded-[14px]', TINT[kind])}>
        <NavIcon d={icon} className="size-5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          title={name}
          className={cn(
            'truncate text-sm leading-tight font-extrabold',
            state === 'off' || placeholder ? 'text-muted' : 'text-fg'
          )}
        >
          {name}
        </span>
        {sub && (
          <span title={sub} className="truncate text-[12.5px] leading-snug text-muted">
            {sub}
          </span>
        )}
      </span>
    </>
  );
  return to ? (
    <Link to={to} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}
