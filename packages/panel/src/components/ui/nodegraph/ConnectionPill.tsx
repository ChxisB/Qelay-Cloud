import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { ConnectionGlyph, type ConnectionState } from './connectionState';

/**
 * The connection's name on its line, and the way into it: the state glyph, then the name. The state's word
 * is in the accessible name ("Order delivery, Active"), so the glyph and the line's pattern are cues beyond it.
 */
export function ConnectionPill({
  name,
  state,
  stateLabel,
  className,
  ...link
}: Omit<LinkProps, 'children'> & { name: string; state: ConnectionState; stateLabel: string }) {
  return (
    <Link
      aria-label={`${name}, ${stateLabel}`}
      className={cn(
        'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border-[1.5px] border-line-strong bg-surface py-0 pr-3.5 pl-2.5 text-[13px] font-bold text-fg',
        'transition-[transform,border-color] duration-(--duration-press) ease-settle',
        'hover:border-muted active:scale-[0.97]',
        className
      )}
      {...link}
    >
      <ConnectionGlyph state={state} />
      <span className="min-w-0 truncate">{name}</span>
    </Link>
  );
}
