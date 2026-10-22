import { Link, useLocation } from 'react-router-dom';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { iconButtonClass } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { isDemo } from '@/lib/demo/isDemo';
import { startPageTransition } from '@/lib/pageTransition';
import { useAlertRuntimeStore } from '@/lib/useAlertEngine';
import { Breadcrumb } from './Breadcrumb';
import { ICON, NavIcon } from './NavIcon';
import { titleFor, useDocumentTitle } from './pageTitle';

const DEMO = isDemo();

const openPalette = () => window.dispatchEvent(new Event('command-palette:open'));

/** One of the toggle's two icons: the shown one rests, the other waits turned away and small. */
const swap = (shown: boolean) => ({
  opacity: shown ? 1 : 0,
  transform: shown ? 'none' : 'rotate(-70deg) scale(0.6)',
});

/** Labelled with the mode you switch *to*, in sentence case. The icons turn into each other. */
function ThemeToggle() {
  const dark = useThemeStore((s) => s.theme === 'dark');
  const toggle = useThemeStore((s) => s.toggle);
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={iconButtonClass('default', 'md', 'relative overflow-hidden')}
    >
      {[
        { d: ICON.sun, shown: dark },
        { d: ICON.moon, shown: !dark },
      ].map(({ d, shown }) => (
        <span
          key={d}
          aria-hidden="true"
          style={swap(shown)}
          className="absolute inset-0 grid place-items-center transition-[transform,opacity] duration-(--dur-enter) ease-settle"
        >
          <NavIcon d={d} className="size-4" />
        </span>
      ))}
    </button>
  );
}

export function Topbar({
  onMenu,
  navOpen = false,
}: {
  onMenu?: (opener: HTMLButtonElement) => void;
  navOpen?: boolean;
}) {
  const { pathname } = useLocation();
  const triggered = useAlertRuntimeStore((s) => s.breaching.length);
  const alerts = triggered > 0 ? `Alerts, ${triggered} triggered` : 'Alerts';
  useDocumentTitle(titleFor(pathname));
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-header-glass px-[clamp(16px,2vw,24px)] py-2 backdrop-blur-md">
      <div className="mr-auto flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={(event) => onMenu?.(event.currentTarget)}
          className={iconButtonClass('default', 'md', 'lg:hidden')}
        >
          <NavIcon d={ICON.menu} className="size-4" />
        </button>
        <Breadcrumb pathname={pathname} />
      </div>
      {DEMO && (
        <span
          title="Showing canned sample data. No real server is connected."
          className="hidden items-center gap-1.5 rounded-control border border-link/40 bg-selected px-2 py-0.5 text-xs font-medium text-link md:inline-flex"
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
        className={iconButtonClass('default', 'md', 'sm:hidden')}
      >
        <NavIcon d={ICON.search} className="size-4" />
      </button>
      <button
        type="button"
        onClick={openPalette}
        title="Command palette (⌘K)"
        aria-label="Open command palette"
        className="hidden min-h-8 max-w-[360px] min-w-0 flex-[1_1_200px] items-center gap-2 rounded-control border border-line-strong bg-surface pr-2 pl-3 text-[13px] text-faint transition-colors hover:text-fg sm:flex"
      >
        <NavIcon d={ICON.search} className="size-4" />
        <span>Search or jump to…</span>
        <Kbd className="ml-auto">⌘K</Kbd>
      </button>
      <ThemeToggle />
      <Link
        to="/alerts"
        aria-label={alerts}
        title={alerts}
        onClick={(event) => startPageTransition(event, pathname === '/alerts')}
        className={iconButtonClass('default', 'md', 'relative')}
      >
        <NavIcon d={ICON.alerts} className="size-4" />
        {triggered > 0 && (
          <span
            aria-hidden="true"
            className="motion-fade absolute top-1 right-1 size-2.5 rounded-full border-2 border-surface bg-hl"
          />
        )}
      </Link>
    </header>
  );
}
