import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { visibleNav } from '@/components/layout/navConfig';
import { SearchField } from '@/components/ui/SearchField';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/usePresence';
import { type Command, PaletteResults } from './CommandPaletteList';

/**
 * Global command palette (Cmd/Ctrl-K). Fuzzy-searches every navigation
 * destination (sourced from the sidebar NAV, so it stays in sync) plus a few
 * actions, and jumps there. Fully keyboard-driven: ↑/↓ to move, ↵ to run, esc
 * to close. Mounted once in AppLayout. Opens on the hotkey or a
 * `command-palette:open` window event (dispatched by the Topbar trigger).
 */

const DOCS_URL = 'https://chxisb.github.io/qelay-control-panel/docs/';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isolateSiblings(modalRoot: HTMLElement): () => void {
  const parent = modalRoot.parentElement;
  if (!parent) return () => {};
  const siblings = Array.from(parent.children).filter(
    (node) => node !== modalRoot
  ) as HTMLElement[];
  const previous = siblings.map((node) => ({
    node,
    inert: node.inert,
    ariaHidden: node.getAttribute('aria-hidden'),
  }));
  for (const node of siblings) {
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const { node, inert, ariaHidden } of previous) {
      node.inert = inert;
      if (ariaHidden == null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', ariaHidden);
    }
  };
}

export function CommandPalette() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const open = useGlobalModalStore((state) => state.active === 'command-palette');
  const { mounted, leaving } = usePresence(open);
  const releaseModal = useGlobalModalStore((state) => state.release);
  const navigate = useNavigate();
  const toggleTheme = useThemeStore((s) => s.toggle);
  const { isPageAvailable } = useCapabilities();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => releaseModal('command-palette'), [releaseModal]);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = visibleNav(isPageAvailable).flatMap((group) =>
      group.items.map((item) => ({
        id: `nav:${item.to}`,
        group: 'Pages',
        label: item.label,
        hint: group.section ?? 'Home',
        run: () => navigate(item.to),
      }))
    );
    const actions: Command[] = [
      {
        id: 'act:theme',
        group: 'Actions',
        label: 'Toggle theme (dark / light)',
        hint: 'Action',
        run: toggleTheme,
      },
      {
        id: 'act:docs',
        group: 'Actions',
        label: 'Open documentation',
        hint: 'Action',
        run: () => window.open(DOCS_URL, '_blank', 'noopener'),
      },
    ];
    return [...nav, ...actions];
  }, [navigate, toggleTheme, isPageAvailable]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q));
  }, [commands, query]);

  // Open on Cmd/Ctrl-K or a window event; the hotkey also toggles it closed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const modal = useGlobalModalStore.getState();
        if (modal.active === 'command-palette') modal.release('command-palette');
        else modal.request('command-palette');
      }
    };
    const onOpen = () => useGlobalModalStore.getState().request('command-palette');
    window.addEventListener('keydown', onKey);
    window.addEventListener('command-palette:open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('command-palette:open', onOpen);
    };
  }, []);

  // Reset and focus the input each time it opens. While modal, keep keyboard
  // focus inside, make the app behind it inert to pointer/AT navigation, and
  // restore both the previous DOM state and opener focus on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    // AppLayout owns declarative shell isolation. Keep the local fallback for
    // standalone embeds/tests where no shell exists.
    const restoreIsolation =
      rootRef.current && !document.getElementById('app-shell')
        ? isolateSiblings(rootRef.current)
        : () => {};
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    const onModalKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeElement = document.activeElement;
      if (e.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onModalKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onModalKey);
      restoreIsolation();
      if (mayRestoreModalFocus('command-palette') && previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, close]);

  // Keep the highlighted row visible while arrowing.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  const exec = useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      c.run();
      close();
    },
    [close]
  );

  if (!mounted) return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(filtered[active]);
    }
  };

  return (
    <div
      ref={rootRef}
      inert={leaving || undefined}
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]',
        leaving && 'pointer-events-none'
      )}
    >
      {/* Backdrop as a real button so "click outside to close" is keyboard- and
          screen-reader-accessible. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close command palette"
        onClick={close}
        className={cn('fixed inset-0 bg-scrim', leaving ? 'motion-fade-out' : 'motion-fade')}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          'relative z-10 flex w-full max-w-[640px] flex-col overflow-hidden rounded-[24px] border border-line-strong bg-raised shadow-pop',
          leaving ? 'motion-leave' : 'motion-drop'
        )}
      >
        <SearchField
          ref={inputRef}
          role="combobox"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // reset the highlight to the top on each keystroke
          }}
          onKeyDown={onKeyDown}
          placeholder="Search pages and actions…"
          aria-label="Search pages and actions"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={filtered[active] ? `command-palette-option-${active}` : undefined}
          autoComplete="off"
          name="command-palette-search"
          shortcut="Esc"
          containerClassName="m-3"
        />
        <PaletteResults
          listRef={listRef}
          commands={filtered}
          active={active}
          onHover={setActive}
          onPick={exec}
        />
      </div>
    </div>
  );
}
