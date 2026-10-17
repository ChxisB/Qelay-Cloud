import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import type { NavItemDef } from './navConfig';

/**
 * Shared row geometry for sidebar links and the footer theme toggle: 36px tall, 10px radius,
 * 14px / 500, icon 18px. Hover and focus are the same everywhere in the shell.
 */
export const NAV_ROW =
  'flex h-9 w-full items-center gap-3 rounded-control px-3 text-sm font-medium text-muted transition-colors ' +
  'hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function NavItem({ to, label, icon: Icon, end }: NavItemDef) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          NAV_ROW,
          'relative',
          // Active: filled row, 600 weight, and a violet bar on the left edge. In light mode the
          // fill is white with a 1px line so the row still reads on the grey sidebar.
          isActive && 'bg-hover font-semibold text-fg light:bg-surface light:ring-1 light:ring-line'
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute inset-y-2 left-0 w-[3px] rounded-[2px] bg-ring"
            />
          )}
          <Icon className="size-[18px] shrink-0" />
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}
