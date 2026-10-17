import { useLocation } from 'react-router-dom';
import { QelayLogo } from '@/components/brand/QelayLogo';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { useNavGroups } from '@/lib/useNavGroups';
import { ConnectionBadge } from './ConnectionBadge';
import { NAV, locateNav, visibleNav } from './navConfig';
import { NavGroup } from './NavGroup';
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
  return (
    <>
      {/* Mobile overlay behind the drawer. */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
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
          'flex w-60 shrink-0 flex-col border-r border-line bg-sidebar',
          // Off-canvas drawer below lg; static column at lg and up. `invisible`
          // (transitioned) keeps the closed drawer's links out of the tab order for
          // keyboard/AT users while preserving the slide animation.
          'fixed inset-y-0 left-0 z-50 transition-[transform,visibility] lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0 invisible lg:visible'
        )}
      >
        <div className="px-[22px] py-5">
          <QelayLogo />
        </div>

        <nav
          aria-label="Primary"
          className="flex flex-1 flex-col gap-2.5 overscroll-contain overflow-y-auto px-3.5 pb-4"
        >
          {groups.map((group) => {
            const { section } = group;
            return (
              <NavGroup
                key={section ?? 'root'}
                group={group}
                open={section === null || isOpen(section)}
                onToggle={() => section !== null && toggle(section)}
              />
            );
          })}
        </nav>

        <ConnectionBadge />
        <SidebarFooter />
      </div>
    </>
  );
}
