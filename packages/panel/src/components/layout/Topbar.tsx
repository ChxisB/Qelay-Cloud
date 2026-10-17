import { Link, useLocation } from 'react-router-dom';
import { IconMenu, IconSearch, IconSliders } from '@/components/ui/icons';
import { Kbd } from '@/components/ui/Kbd';
import { getActiveSession } from '@/lib/auth/activeSession';
import { useAuthStore } from '@/lib/auth/authStore';
import { cn } from '@/lib/cn';
import { isDemo } from '@/lib/demo/isDemo';
import { Breadcrumb } from './Breadcrumb';
import { titleFor, useDocumentTitle } from './pageTitle';

const DEMO = isDemo();

const ICON_BUTTON =
  'flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const openPalette = () => window.dispatchEvent(new Event('command-palette:open'));

export function Topbar({
  onMenu,
  navOpen = false,
}: {
  onMenu?: (opener: HTMLButtonElement) => void;
  navOpen?: boolean;
}) {
  const { pathname } = useLocation();
  const signedIn = useAuthStore((s) => s.managed && s.status === 'ready');
  useDocumentTitle(titleFor(pathname));
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={(event) => onMenu?.(event.currentTarget)}
          className={cn('-ml-1 lg:hidden', ICON_BUTTON)}
        >
          <IconMenu className="size-5" />
        </button>
        <Breadcrumb pathname={pathname} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {DEMO && (
          <span
            title="Showing canned sample data. No real server is connected."
            className="hidden items-center gap-1.5 rounded-full border border-link/40 bg-selected px-2.5 py-1 text-xs font-medium text-link sm:inline-flex"
          >
            <span className="size-1.5 rounded-full bg-link" />
            Live demo
          </span>
        )}
        <button
          type="button"
          onClick={openPalette}
          title="Command palette"
          aria-label="Open command palette"
          className={cn('sm:hidden', ICON_BUTTON)}
        >
          <IconSearch className="size-5" />
        </button>
        <button
          type="button"
          onClick={openPalette}
          title="Command palette (⌘K)"
          aria-label="Open command palette"
          className="hidden h-9 w-[260px] items-center gap-2 rounded-control border border-line-strong bg-surface-2 px-3 text-[13px] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring light:bg-surface sm:flex"
        >
          <IconSearch className="size-4 shrink-0" />
          <span>Search or jump to…</span>
          <Kbd className="ml-auto">⌘K</Kbd>
        </button>
        {signedIn && (
          <button
            type="button"
            onClick={() => void getActiveSession()?.signOut()}
            className="h-9 shrink-0 rounded-control px-2 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Sign out
          </button>
        )}
        <Link to="/settings" title="Settings" aria-label="Settings" className={ICON_BUTTON}>
          <IconSliders className="size-[18px]" />
        </Link>
      </div>
    </header>
  );
}
