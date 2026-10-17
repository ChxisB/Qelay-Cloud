import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useThemeStore } from '../src/components/dashboard/stores/themeStore';
import { Breadcrumb, crumbsFor } from '../src/components/layout/Breadcrumb';
import { locateNav, NAV } from '../src/components/layout/navConfig';
import { Sidebar } from '../src/components/layout/Sidebar';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { NAV_GROUPS_STORAGE_KEY, useNavGroups } from '../src/lib/useNavGroups';
import { renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function sidebarAt(path: string) {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Sidebar)));
}

function toggleFor(host: HTMLElement, section: string): HTMLButtonElement {
  const button = Array.from(
    host.querySelectorAll<HTMLButtonElement>('nav button[aria-expanded]')
  ).find((candidate) => candidate.textContent?.startsWith(section));
  if (!button) throw new Error(`no toggle for ${section}`);
  return button;
}

/** The navigation is filtered by what the server offers: these tests start from "everything on". */
function serve(caps: typeof DEMO_CAPABILITIES, status: 'ready' | 'loading' | 'error' = 'ready') {
  useCapabilitiesStore.setState({ status, caps, error: null, key: 'test' });
}

beforeEach(() => {
  serve(DEMO_CAPABILITIES);
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  // ConnectionBadge polls /health. A request that never settles keeps it in "connecting", so
  // nothing touches the network and no state update lands outside act().
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  serve(DEMO_CAPABILITIES, 'ready');
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
});

describe('nav data', () => {
  test('keeps the route set and group order the design shows', () => {
    expect(NAV.map((group) => group.section)).toEqual([
      null,
      'Queues',
      'Workflow',
      'Monitoring',
      'Control',
      'Management',
    ]);
    expect(NAV.flatMap((group) => group.items).length).toBe(28);
  });

  test('locateNav picks the most specific item', () => {
    expect(locateNav('/')).toEqual({ section: null, label: 'Overview' });
    expect(locateNav('/jobs')).toEqual({ section: 'Queues', label: 'Jobs' });
    expect(locateNav('/jobs/bulk-add')).toEqual({ section: 'Control', label: 'Bulk Add' });
    expect(locateNav('/workflows')).toEqual({ section: 'Workflow', label: 'Workflows' });
    expect(locateNav('/flows')).toEqual({ section: 'Workflow', label: 'Job Flows' });
    // Prefix routes keep their group, and a sibling with the same stem does not match.
    expect(locateNav('/dlq/anything')).toEqual({ section: 'Queues', label: 'Dead Letter Queue' });
    expect(locateNav('/dlq-control')).toEqual({ section: 'Control', label: 'DLQ Control' });
  });

  test('a queue detail page lives under Queues without being a nav item', () => {
    expect(locateNav('/queues/email%20jobs')).toEqual({ section: 'Queues', label: null });
  });

  test('routes outside the nav are not located', () => {
    expect(locateNav('/overview-classic')).toBeNull();
    expect(locateNav('/nope')).toBeNull();
  });
});

describe('breadcrumb', () => {
  test('builds the trail from the nav group and item', () => {
    expect(crumbsFor('/')).toEqual(['Control panel', 'Overview']);
    expect(crumbsFor('/jobs')).toEqual(['Control panel', 'Queues', 'Jobs']);
    // The sidebar label, not the document title.
    expect(crumbsFor('/workflows')).toEqual(['Control panel', 'Workflow', 'Workflows']);
  });

  test('falls back to the page title outside the nav', () => {
    expect(crumbsFor('/queues/email%20jobs')).toEqual([
      'Control panel',
      'Queues',
      'email jobs · Queue',
    ]);
    expect(crumbsFor('/nope')).toEqual(['Control panel', 'Page not found']);
  });

  test('marks only the last crumb as the current page', () => {
    const { host } = render(
      createElement(MemoryRouter, {}, createElement(Breadcrumb, { pathname: '/jobs' }))
    );
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Breadcrumb');
    const current = host.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.textContent).toBe('Jobs');
  });
});

describe('useNavGroups', () => {
  test('opens only Queues by default', () => {
    const hook = renderHook(() => useNavGroups(null, '/'));
    expect(hook.result.current.isOpen('Queues')).toBe(true);
    expect(hook.result.current.isOpen('Monitoring')).toBe(false);
    expect(hook.result.current.isOpen('Control')).toBe(false);
    hook.unmount();
  });

  test('the group holding the current route is open on load', () => {
    const hook = renderHook(() => useNavGroups('Management', '/settings'));
    expect(hook.result.current.isOpen('Management')).toBe(true);
    hook.unmount();
  });

  test('navigating into a collapsed group opens it, even over a saved collapse', () => {
    localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify({ Monitoring: false }));
    const hook = renderHook(
      ({ section, path }: { section: string | null; path: string }) => useNavGroups(section, path),
      { section: 'Queues', path: '/jobs' }
    );
    expect(hook.result.current.isOpen('Monitoring')).toBe(false);
    hook.rerender({ section: 'Monitoring', path: '/metrics' });
    expect(hook.result.current.isOpen('Monitoring')).toBe(true);
    hook.unmount();
  });

  test('a toggle persists, and the viewer can collapse the active group', () => {
    const hook = renderHook(() => useNavGroups('Queues', '/jobs'));
    act(() => hook.result.current.toggle('Queues'));
    expect(hook.result.current.isOpen('Queues')).toBe(false);
    expect(JSON.parse(localStorage.getItem(NAV_GROUPS_STORAGE_KEY) ?? '{}')).toEqual({
      Queues: false,
    });
    act(() => hook.result.current.toggle('Control'));
    expect(hook.result.current.isOpen('Control')).toBe(true);
    hook.unmount();

    // A fresh mount elsewhere restores the saved choices.
    const next = renderHook(() => useNavGroups(null, '/'));
    expect(next.result.current.isOpen('Queues')).toBe(false);
    expect(next.result.current.isOpen('Control')).toBe(true);
    next.unmount();
  });

  test('a navigation-forced open is not written to storage', () => {
    const hook = renderHook(() => useNavGroups('Monitoring', '/metrics'));
    expect(hook.result.current.isOpen('Monitoring')).toBe(true);
    expect(localStorage.getItem(NAV_GROUPS_STORAGE_KEY)).toBeNull();
    hook.unmount();
  });

  test('corrupt or foreign stored values fall back to the defaults', () => {
    for (const bad of ['not json', '[]', '"x"', '{"Queues":"yes"}']) {
      localStorage.setItem(NAV_GROUPS_STORAGE_KEY, bad);
      const hook = renderHook(() => useNavGroups(null, '/'));
      expect(hook.result.current.isOpen('Queues')).toBe(true);
      expect(hook.result.current.isOpen('Control')).toBe(false);
      hook.unmount();
    }
  });

  test('toggling still works when storage throws', () => {
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('quota');
    };
    try {
      const hook = renderHook(() => useNavGroups(null, '/'));
      act(() => hook.result.current.toggle('Control'));
      expect(hook.result.current.isOpen('Control')).toBe(true);
      hook.unmount();
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});

describe('Sidebar', () => {
  test('labels the navigation landmark and exposes each group as a disclosure', () => {
    const { host } = sidebarAt('/jobs');
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Primary');
    const toggles = Array.from(
      host.querySelectorAll<HTMLButtonElement>('nav button[aria-expanded]')
    );
    // Five labelled groups; the unlabelled root group has no header.
    expect(toggles.length).toBe(5);
    for (const toggle of toggles) {
      expect(toggle.type).toBe('button');
      expect(['true', 'false']).toContain(toggle.getAttribute('aria-expanded') ?? '');
      expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    }
    expect(toggleFor(host, 'Queues').getAttribute('aria-expanded')).toBe('true');
    expect(toggleFor(host, 'Control').getAttribute('aria-expanded')).toBe('false');
  });

  test('a collapsed group hides its links and shows its item count', () => {
    const { host } = sidebarAt('/jobs');
    const control = toggleFor(host, 'Control');
    expect(control.textContent).toContain('9');
    expect(host.querySelector('a[href="/server"]')).toBeNull();
    // Open groups do not show a count.
    expect(toggleFor(host, 'Queues').textContent).not.toMatch(/\d/);
  });

  test('toggling opens and closes a group', () => {
    const { host } = sidebarAt('/jobs');
    act(() => toggleFor(host, 'Control').click());
    expect(toggleFor(host, 'Control').getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('a[href="/server"]')).not.toBeNull();
    expect(toggleFor(host, 'Control').textContent).not.toMatch(/\d/);
    act(() => toggleFor(host, 'Control').click());
    expect(host.querySelector('a[href="/server"]')).toBeNull();
  });

  test('the current route opens its group and carries aria-current', () => {
    const { host } = sidebarAt('/metrics');
    expect(toggleFor(host, 'Monitoring').getAttribute('aria-expanded')).toBe('true');
    const current = host.querySelectorAll('a[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute('href')).toBe('/metrics');
    // The violet bar is the only active-row decoration.
    expect(current[0]?.querySelector('span[aria-hidden="true"].bg-ring')).not.toBeNull();
  });

  test('every nav destination is reachable once the groups are open', () => {
    const { host } = sidebarAt('/');
    for (const toggle of host.querySelectorAll<HTMLButtonElement>(
      'nav button[aria-expanded="false"]'
    )) {
      act(() => toggle.click());
    }
    const hrefs = Array.from(host.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(NAV.flatMap((group) => group.items.map((item) => item.to)));
  });
});

describe('Sidebar footer', () => {
  const initialTheme = useThemeStore.getState().theme;
  const initialAgent = useConnectionStore.getState().agentBaseUrl;
  afterEach(() => {
    // Unmount first: restoring a store under a mounted subscriber is an update outside act().
    for (const unmount of [...mounted]) unmount();
    useThemeStore.setState({ theme: initialTheme });
    useConnectionStore.setState({ agentBaseUrl: initialAgent });
  });

  test('the theme toggle names the mode you switch to, in sentence case', async () => {
    useThemeStore.setState({ theme: 'dark' });
    const { host } = sidebarAt('/');
    const button = () =>
      Array.from(host.querySelectorAll('button')).find((b) =>
        /(Light|Dark) mode/.test(b.textContent ?? '')
      );
    expect(button()?.textContent).toBe('Light mode');
    act(() => button()?.click());
    await settle(1);
    expect(button()?.textContent).toBe('Dark mode');
  });

  test('the agent line reports the configured host and port', () => {
    useConnectionStore.setState({ agentBaseUrl: 'http://localhost:6800' });
    const { host } = sidebarAt('/');
    expect(host.textContent).toContain('Control agent · localhost:6800');
    act(() => useConnectionStore.setState({ agentBaseUrl: 'https://agent.example.test:7001/' }));
    expect(host.textContent).toContain('Control agent · agent.example.test:7001');
  });
});
