import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { QelayLogo } from '@/components/brand/QelayLogo';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { useNavGroups } from '@/lib/useNavGroups';
import { usePresence } from '@/lib/usePresence';
import { NAV, isNavCurrent, locateNav, visibleNav } from './navConfig';
import { NavGroup } from './NavGroup';
import { NodeSwitcher } from './NodeSwitcher';
import { SidebarFooter } from './SidebarFooter';

// The nav data lives in navConfig so the breadcrumb and the command palette read the same list.
export { NAV };

export function Sidebar({
  open = false,
  blocked = false,
  onClose,
}: {
  open?: boolean;
  blocked?: boolean;
  onClose?: () => void;
}) {
  const { pathname } = useLocation();
  const { isOpen, toggle } = useNavGroups(locateNav(pathname)?.section ?? null, pathname);
  const { isPageAvailable } = useCapabilities();
  const groups = visibleNav(isPageAvailable);
  const scrim = usePresence(open);

  // One highlight slides to the current row (motion.css). It needs the row's place, which only a
  // browser can give: where there is none (no layout, no current page, a folded group) it is not drawn
  // and each row washes itself. Read after every render, so a fold above the row moves it too.
  const navRef = useRef<HTMLElement>(null);
  const [mark, setMark] = useState<{ y: number; h: number } | null>(null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- no list on purpose: the bail-out below stops the loop
  useLayoutEffect(() => {
    const row = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const next = row && row.offsetHeight > 0 ? { y: row.offsetTop, h: row.offsetHeight } : null;
    setMark((prev) => (prev?.y === next?.y && prev?.h === next?.h ? prev : next));
  });

  return (
    <>
      {/* Mobile overlay behind the drawer; it fades out for as long as the drawer slides away. */}
      {scrim.mounted && (
        <button
          type="button"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={onClose}
          className={cn(
            'fixed inset-0 z-40 bg-scrim lg:hidden',
            scrim.leaving ? 'motion-fade-out pointer-events-none' : 'motion-fade'
          )}
        />
      )}
      {/* Static analysis cannot correlate these conditional props: aria-modal is present
          only in the same branch where role="dialog". */}
      <div
        id="app-nav"
        role={open ? 'dialog' : 'complementary'}
        aria-modal={open || undefined}
        aria-label={open ? 'Navigation menu' : undefined}
        inert={blocked ? true : undefined}
        aria-hidden={blocked || undefined}
        className={cn(
          'flex w-[232px] shrink-0 flex-col gap-3 border-r border-line bg-sidebar px-2.5 py-3',
          // Off-canvas drawer below lg; static column at lg and up. `invisible`
          // (transitioned) keeps the closed drawer's links out of the tab order for
          // keyboard/AT users while preserving the slide animation. It slides in at the enter
          // time and out at the exit time, like the overlays.
          'fixed inset-y-0 left-0 z-50 transition-[transform,visibility] lg:static lg:z-auto lg:translate-x-0',
          open
            ? 'translate-x-0 duration-(--dur-enter) ease-settle'
            : '-translate-x-full lg:translate-x-0 invisible lg:visible duration-(--dur-exit) ease-exit'
        )}
      >
        <Link
          to="/"
          className="flex min-h-8 shrink-0 items-center rounded-control px-2 text-fg no-underline"
        >
          <QelayLogo />
        </Link>
        <NodeSwitcher />

        <nav
          ref={navRef}
          aria-label="Primary"
          data-nav-slide={mark ? '' : undefined}
          // The padding is room for the 3px focus ring, which the scroll container would otherwise clip.
          className="relative -mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 py-1.5"
        >
          {mark && (
            <span
              aria-hidden="true"
              className="nav-ind pointer-events-none absolute inset-x-2 top-0 rounded-control bg-selected"
              style={{ transform: `translateY(${mark.y}px)`, height: mark.h }}
            />
          )}
          {groups.map((group) => {
            const { section } = group;
            return (
              <NavGroup
                key={section ?? 'root'}
                group={group}
                open={section === null || isOpen(section)}
                hasCurrent={group.items.some((item) => isNavCurrent(item, pathname))}
                onToggle={() => section !== null && toggle(section)}
              />
            );
          })}
        </nav>

        <SidebarFooter />
      </div>
    </>
  );
}
