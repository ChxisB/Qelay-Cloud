import { useId } from 'react';
import { IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { NavGroupDef } from './navConfig';
import { NavItem } from './NavItem';

/**
 * One sidebar group. The unlabelled root group is always open and has no header. A labelled
 * group is a disclosure: a button with the eyebrow label, a chevron, and its item count while
 * collapsed. Collapsed items are unmounted (not just hidden) so they leave the tab order and the
 * mobile drawer's focus trap.
 */
export function NavGroup({
  group,
  open,
  onToggle,
}: {
  group: NavGroupDef;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const items = (
    <div id={panelId} className="flex flex-col gap-0.5">
      {group.items.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </div>
  );

  if (!group.section) return items;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex h-[30px] w-full items-center justify-between rounded-lg px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span>{group.section}</span>
        <span className="flex items-center gap-2">
          {!open && (
            <span className="text-xs font-medium normal-case tracking-normal tabular-nums">
              {group.items.length}
            </span>
          )}
          <IconChevronRight
            className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')}
          />
        </span>
      </button>
      {open && items}
    </div>
  );
}
