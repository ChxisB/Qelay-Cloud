import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Breadcrumb, crumbsFor } from '../src/components/layout/Breadcrumb';
import { locateNav, NAV, navPaths } from '../src/components/layout/navConfig';
import { Sidebar } from '../src/components/layout/Sidebar';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { NAV_GROUPS_STORAGE_KEY } from '../src/lib/useNavGroups';
import './domSetup';

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
      'Work',
      'Automation',
      'Monitor',
      'System',
    ]);
    // 28 on the boards; Workflows and Job flows are one item (event-gateway plan, task 06), five
    // Control pages are part of their parent page (task 02), four reports are Health (task 03) and six
    // pages are System (task 04).
    expect(NAV.flatMap((group) => group.items).length).toBe(14);
  });

  test('no item stands for a page that only redirects', () => {
    const redirects = ['/queue-control', '/dlq-control', '/cron-manager', '/workflows/executions'];
    const paths = NAV.flatMap((group) => group.items.flatMap(navPaths));
    for (const path of redirects) expect(paths).not.toContain(path);
    expect(paths.filter((path) => path.endsWith('-classic'))).toEqual([]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('locateNav picks the most specific item', () => {
    expect(locateNav('/')).toEqual({ section: null, label: 'Home' });
    expect(locateNav('/jobs')).toEqual({ section: 'Work', label: 'Jobs' });
    // Add job, Bulk add and the inspector are pages of Jobs.
    for (const path of ['/jobs/bulk-add', '/add-job', '/job']) {
      expect(locateNav(path)).toEqual({ section: 'Work', label: 'Jobs' });
    }
    // Job flows and workflow runs are one item: it is current on both pages.
    expect(locateNav('/workflows')).toEqual({ section: 'Automation', label: 'Flows' });
    expect(locateNav('/flows')).toEqual({ section: 'Automation', label: 'Flows' });
    // Prefix routes keep their group, and a sibling with the same stem does not match.
    expect(locateNav('/dlq/anything')).toEqual({ section: 'Work', label: 'Dead letter queue' });
    expect(locateNav('/dlq-control')).toBeNull();
  });

  test('a queue detail page lives under Work without being a nav item', () => {
    expect(locateNav('/queues/email%20jobs')).toEqual({ section: 'Work', label: null });
  });

  test('routes outside the nav are not located', () => {
    expect(locateNav('/nope')).toBeNull();
  });
});

describe('breadcrumb', () => {
  test('builds the trail from the nav group and item', () => {
    expect(crumbsFor('/', 'Local')).toEqual(['Local', 'Home']);
    expect(crumbsFor('/jobs', 'Local')).toEqual(['Local', 'Work', 'Jobs']);
    // The sidebar label, not the document title.
    expect(crumbsFor('/workflows', 'Local')).toEqual(['Local', 'Automation', 'Flows']);
  });

  test('falls back to the page title outside the nav', () => {
    expect(crumbsFor('/queues/email%20jobs', 'Local')).toEqual([
      'Local',
      'Work',
      'email jobs · Queue',
    ]);
    expect(crumbsFor('/nope', 'Local')).toEqual(['Local', 'Page not found']);
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

describe('Sidebar', () => {
  test('labels the navigation landmark and exposes each group as a disclosure', () => {
    const { host } = sidebarAt('/jobs');
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Primary');
    const toggles = Array.from(
      host.querySelectorAll<HTMLButtonElement>('nav button[aria-expanded]')
    );
    // Four labelled groups; the unlabelled root group has no header.
    expect(toggles.length).toBe(4);
    for (const toggle of toggles) {
      expect(toggle.type).toBe('button');
      expect(['true', 'false']).toContain(toggle.getAttribute('aria-expanded') ?? '');
      expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    }
    expect(toggleFor(host, 'Work').getAttribute('aria-expanded')).toBe('true');
    expect(toggleFor(host, 'Automation').getAttribute('aria-expanded')).toBe('false');
  });

  test('a collapsed group hides its links and shows its item count', () => {
    const { host } = sidebarAt('/jobs');
    const control = toggleFor(host, 'Automation');
    expect(control.textContent).toContain('2');
    expect(host.querySelector('a[href="/events-gateway"]')).toBeNull();
    // Open groups do not show a count.
    expect(toggleFor(host, 'Work').textContent).not.toMatch(/\d/);
  });

  test('toggling opens and closes a group', () => {
    const { host } = sidebarAt('/jobs');
    act(() => toggleFor(host, 'Automation').click());
    expect(toggleFor(host, 'Automation').getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('a[href="/events-gateway"]')).not.toBeNull();
    expect(toggleFor(host, 'Automation').textContent).not.toMatch(/\d/);
    act(() => toggleFor(host, 'Automation').click());
    expect(host.querySelector('a[href="/events-gateway"]')).toBeNull();
  });

  test('the current route opens its group and carries aria-current', () => {
    const { host } = sidebarAt('/metrics');
    expect(toggleFor(host, 'Monitor').getAttribute('aria-expanded')).toBe('true');
    const current = host.querySelectorAll('a[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute('href')).toBe('/metrics');
    // The design's active row is a wash and a heavier weight, with no bar.
    expect(current[0]?.className).toContain('bg-selected');
    expect(current[0]?.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  test('a connection page keeps the Event gateway item current, under Automation', () => {
    for (const path of [
      '/events-gateway/connections/hook-1',
      '/events-gateway/connections/hook-1/metrics',
    ]) {
      const { host, unmount } = sidebarAt(path);
      expect(toggleFor(host, 'Automation').getAttribute('aria-expanded')).toBe('true');
      const current = host.querySelectorAll('a[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute('href')).toBe('/events-gateway');
      expect(crumbsFor(path, 'Local')).toEqual(['Local', 'Automation', 'Event gateway']);
      unmount();
    }
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
  const initialAgent = useConnectionStore.getState().agentBaseUrl;
  afterEach(() => {
    // Unmount first: restoring a store under a mounted subscriber is an update outside act().
    for (const unmount of [...mounted]) unmount();
    useConnectionStore.setState({ agentBaseUrl: initialAgent });
  });

  test('the agent line reports the configured host and port', () => {
    useConnectionStore.setState({ agentBaseUrl: 'http://localhost:6800' });
    const { host } = sidebarAt('/');
    expect(host.textContent).toContain('Control agent · localhost:6800');
    act(() => useConnectionStore.setState({ agentBaseUrl: 'https://agent.example.test:7001/' }));
    expect(host.textContent).toContain('Control agent · agent.example.test:7001');
  });
});
