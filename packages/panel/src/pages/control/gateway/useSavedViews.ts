import { useState } from 'react';

export const SAVED_VIEWS_KEY = 'qelay-gateway-event-views';
export const MAX_VIEWS = 20;
export const MAX_NAME = 40;

/** The Events filters that go to the server, kept under a name. */
export interface SavedView {
  name: string;
  route: string;
  status: string;
  range: string;
}

const FIELDS = ['name', 'route', 'status', 'range'] as const;

const isView = (value: unknown): value is SavedView =>
  typeof value === 'object' &&
  value !== null &&
  FIELDS.every((key) => typeof (value as Record<string, unknown>)[key] === 'string') &&
  (value as SavedView).name !== '';

/** The views in this browser, or null when it blocks storage. Text that is not a list of views is ignored. */
function read(): SavedView[] | null {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(SAVED_VIEWS_KEY);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isView).slice(0, MAX_VIEWS) : [];
  } catch {
    return [];
  }
}

/**
 * Named filter sets for the Events screen. They live in this browser only (a per-viewer convenience): a
 * browser that blocks storage keeps the screen working, with `blocked` true and nothing saved.
 */
export function useSavedViews() {
  const [initial] = useState(read);
  const [views, setViews] = useState<SavedView[]>(initial ?? []);
  const [blocked, setBlocked] = useState(initial === null);

  const write = (next: SavedView[]) => {
    try {
      globalThis.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
      setViews(next);
    } catch {
      setBlocked(true);
    }
  };

  /** A name already in use is replaced; a 21st name is refused. */
  const save = (view: SavedView) => {
    const name = view.name.trim().slice(0, MAX_NAME);
    const others = views.filter((item) => item.name !== name);
    if (blocked || name === '' || others.length >= MAX_VIEWS) return;
    write([...others, { ...view, name }]);
  };

  const remove = (name: string) => {
    if (!blocked) write(views.filter((item) => item.name !== name));
  };

  return { views, blocked, save, remove };
}
