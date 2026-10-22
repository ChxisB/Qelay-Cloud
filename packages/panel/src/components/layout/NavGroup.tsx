import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import type { NavGroupDef } from './navConfig';
import { NavIcon, ICON } from './NavIcon';
import { NavItem } from './NavItem';

const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-faint';

/**
 * One sidebar group. The root group is always open and carries a plain "Console" label. A labelled
 * group is a disclosure: a button with the design's section label, a chevron, and its item count
 * while collapsed, plus a dot when the current page is inside. Collapsed items are unmounted (not
 * just hidden) so they leave the tab order and the mobile drawer's focus trap. Opening one by hand
 * fades its pages in one after another; opening it by navigating, or the first paint, does not.
 */
export function NavGroup({
  group,
  open,
  hasCurrent = false,
  onToggle,
}: {
  group: NavGroupDef;
  open: boolean;
  hasCurrent?: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const [fresh, setFresh] = useState(false);
  const items = (
    <div id={panelId} className={cn('flex flex-col gap-px', fresh && 'motion-stagger')}>
      {group.items.map((item, i) => (
        <NavItem key={item.to} {...item} index={fresh ? i : undefined} />
      ))}
    </div>
  );

  if (!group.section) {
    return (
      <div className="flex flex-col gap-1">
        <p className={cn(LABEL, 'px-2.5 pt-2')}>Console</p>
        {items}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setFresh(!open);
          onToggle();
        }}
        className={cn(
          LABEL,
          'flex min-h-8 w-full items-center justify-between rounded-control px-2.5 pt-2 transition-colors duration-(--duration-hover) ease-settle hover:text-fg'
        )}
      >
        <span>{group.section}</span>
        <span className="flex items-center gap-2">
          {!open && hasCurrent && (
            <>
              <span aria-hidden="true" className="size-2 rounded-full bg-hl" />
              <span className="sr-only">contains the current page</span>
            </>
          )}
          {!open && (
            <span className="rounded-full bg-slate-tint px-2 text-[11.5px] leading-5 font-semibold normal-case tracking-normal tabular-nums text-muted">
              {group.items.length}
            </span>
          )}
          <NavIcon
            d={ICON.chevronRight}
            className={cn(
              'size-3.5 transition-transform duration-(--duration-press) ease-settle',
              open && 'rotate-90'
            )}
          />
        </span>
      </button>
      {open && items}
    </div>
  );
}
