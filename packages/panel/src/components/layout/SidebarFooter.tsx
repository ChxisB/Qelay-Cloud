import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconMoon, IconSun } from '@/components/ui/icons';
import { isDemo } from '@/lib/demo/isDemo';
import { NAV_ROW } from './NavItem';

const REPO_URL = 'https://github.com/ChxisB/qelay-control-panel';
const DOCS_URL = 'https://chxisb.github.io/qelay-control-panel/docs/';
const INSTALL_CMD = 'bunx qelay-control-panel';

/**
 * Demo-only conversion prompt: the hosted demo is the project's most-shared
 * surface, so give a wowed visitor a path to install / star / read the docs
 * instead of leaving them at a dead end. Only rendered under isDemo().
 */
function DemoCta() {
  return (
    <div className="mx-3.5 mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <p className="mb-2 text-[11px] font-medium leading-snug text-fg">
        Like it? Run it on your own server.
      </p>
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{INSTALL_CMD}</code>
        <CopyButton value={INSTALL_CMD} />
      </div>
      <div className="flex items-center gap-2">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-semibold text-primary-fg transition-opacity hover:opacity-90"
        >
          <span aria-hidden>★</span> Star
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center rounded-md border border-line px-2 py-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Docs
        </a>
      </div>
    </div>
  );
}

/** Labelled with the mode you switch *to*, in sentence case. */
function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const dark = theme === 'dark';
  return (
    <button type="button" onClick={toggle} className={NAV_ROW}>
      {dark ? <IconSun className="size-[18px]" /> : <IconMoon className="size-[18px]" />}
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}

/**
 * Where the control agent lives, from the active connection profile. This reports the target,
 * not liveness: the agent has no cheap health route (`/control/status` probes the server and
 * takes a lifecycle lease), so the shell does not poll it. The dot is therefore neutral.
 */
function AgentLine() {
  const agentBaseUrl = useConnectionStore((s) => s.agentBaseUrl);
  const host = agentBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted" title={agentBaseUrl}>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-faint" />
      <span className="min-w-0">
        Control agent · <span className="whitespace-nowrap">{host}</span>
      </span>
    </div>
  );
}

/** Bottom of the sidebar: theme toggle and agent target, under a hairline. */
export function SidebarFooter() {
  return (
    <>
      {isDemo() && <DemoCta />}
      <div className="mx-3.5 mb-4 flex flex-col gap-1 border-t border-line pt-4">
        <ThemeToggle />
        <AgentLine />
      </div>
    </>
  );
}
