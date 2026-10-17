import { useCallback, useEffect, useState } from 'react';

export const NAV_GROUPS_STORAGE_KEY = 'qelay-nav-groups';

/** The design opens only Queues; every other group starts collapsed. */
const DEFAULT_OPEN: ReadonlySet<string> = new Set(['Queues']);

type Stored = Record<string, boolean>;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readNavGroups(): Stored {
  try {
    const raw = storage()?.getItem(NAV_GROUPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, open]) => typeof open === 'boolean')
    );
  } catch {
    return {};
  }
}

function writeNavGroups(value: Stored): void {
  try {
    storage()?.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the groups still toggle, they just don't persist.
  }
}

/**
 * Open/closed state for the sidebar's collapsible groups.
 *
 * A viewer's explicit toggles persist (a per-viewer convenience; the page works without
 * storage). Separately, the group holding the current route is forced open on load and on
 * every navigation, but that is session-only: persisting it would drift the saved state
 * toward "everything open" as the viewer visits pages. Toggling a group hands control back
 * to the viewer until the next navigation.
 */
export function useNavGroups(
  activeSection: string | null,
  pathname: string
): { isOpen: (section: string) => boolean; toggle: (section: string) => void } {
  const [stored, setStored] = useState<Stored>(readNavGroups);
  const [forced, setForced] = useState<ReadonlySet<string>>(
    () => new Set(activeSection ? [activeSection] : [])
  );

  useEffect(() => {
    if (!activeSection) return;
    setForced((prev) => (prev.has(activeSection) ? prev : new Set(prev).add(activeSection)));
  }, [activeSection, pathname]);

  const isOpen = useCallback(
    (section: string) => forced.has(section) || (stored[section] ?? DEFAULT_OPEN.has(section)),
    [forced, stored]
  );

  const toggle = useCallback(
    (section: string) => {
      const next = !isOpen(section);
      const merged = { ...stored, [section]: next };
      setStored(merged);
      writeNavGroups(merged);
      setForced((prev) => {
        if (!prev.has(section)) return prev;
        const rest = new Set(prev);
        rest.delete(section);
        return rest;
      });
    },
    [isOpen, stored]
  );

  return { isOpen, toggle };
}
