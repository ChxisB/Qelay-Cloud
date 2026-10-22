import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { startPageTransition } from '@/lib/pageTransition';
import { stagger } from '@/lib/stagger';
import { type NavItemDef, isNavCurrent } from './navConfig';
import { NavIcon } from './NavIcon';

/**
 * One sidebar link: a 32px row. The current page is a coral wash, a heavier label and a
 * coral icon, and `aria-current` is set, so colour is never the only signal. An item that
 * stands for several pages (`also`) is current on each of them, which `NavLink` cannot say.
 * Where the sidebar measures the row, one shared highlight slides to it and the row's own wash is
 * dropped (motion.css); `index` is its place in a group that has just opened.
 */
export function NavItem({ index, ...item }: NavItemDef & { index?: number }) {
  const { pathname } = useLocation();
  const isActive = isNavCurrent(item, pathname);
  return (
    <Link
      to={item.to}
      aria-current={isActive ? 'page' : undefined}
      onClick={(event) => startPageTransition(event, isActive)}
      style={index === undefined ? undefined : stagger(index)}
      className={cn(
        'relative flex min-h-8 items-center gap-2.5 rounded-control px-2.5 text-sm transition-colors duration-(--duration-hover) ease-settle',
        isActive
          ? 'bg-selected font-semibold text-fg'
          : 'font-medium text-muted hover:bg-hover hover:text-fg'
      )}
    >
      <NavIcon d={item.icon} className={cn('size-4', isActive && 'text-hl')} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
