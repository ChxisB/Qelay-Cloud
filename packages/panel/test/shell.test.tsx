import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useThemeStore } from '../src/components/dashboard/stores/themeStore';
import { Breadcrumb } from '../src/components/layout/Breadcrumb';
import { NAV } from '../src/components/layout/navConfig';
import { Sidebar } from '../src/components/layout/Sidebar';
import { Topbar } from '../src/components/layout/Topbar';
import { UserBlock } from '../src/components/layout/UserBlock';
import { setActiveSession } from '../src/lib/auth/activeSession';
import { useAuthStore } from '../src/lib/auth/authStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES, FAIL_CLOSED } from '../src/lib/capabilities/types';
import { settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function render(element: ReactElement, path = '/') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, element)));
  return host;
}

const initial = {
  theme: useThemeStore.getState().theme,
  profiles: useConnectionStore.getState().profiles,
  auth: useAuthStore.getState(),
};

beforeEach(() => {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 't',
  });
  // The health card polls /health: a request that never settles keeps it quiet.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  setActiveSession(null);
  useThemeStore.setState({ theme: initial.theme });
  useConnectionStore.setState({ profiles: initial.profiles });
  useAuthStore.setState(initial.auth);
});

/** Copied from the design's `qnav.js` (`groups`): the order, grouping and wording of the sidebar. */
const DESIGN_NAV: Array<[string | null, string[]]> = [
  [null, ['Home']],
  // Deviation (task 02): Add job, Bulk add and the job inspector are Jobs; Queue control is a queue's
  // Settings tab and DLQ control was a copy of the dead letter queue.
  ['Work', ['Queues', 'Jobs', 'Dead letter queue', 'Cron jobs']],
  // Deviation from the boards (event-gateway plan, tasks 05 and 06): the Event gateway (webhooks and routes) and Flows are the
  // Automation section, and job flows and workflow runs are one item.
  ['Automation', ['Event gateway', 'Flows']],
  // Deviation (task 03): Deployment, Diagnostics, Job delivery and Usage are the tabs of Health.
  ['Monitor', ['Metrics', 'Workers', 'Logs', 'Alerts', 'Health']],
  // Deviation (task 04): Server, Database, Backups, MCP, Benchmark and Fleet are the tabs of System.
  ['System', ['Settings', 'System']],
];

describe('navigation matches the design', () => {
  test('groups, order and labels are the ones on the boards', () => {
    expect(NAV.map((group) => [group.section, group.items.map((item) => item.label)])).toEqual(
      DESIGN_NAV
    );
  });

  test('every item has an icon and a route of its own', () => {
    const items = NAV.flatMap((group) => group.items);
    expect(new Set(items.map((item) => item.to)).size).toBe(items.length);
    for (const item of items) expect(item.icon.length, item.label).toBeGreaterThan(8);
  });
});

describe('landmarks', () => {
  test('the sidebar is a complementary region holding the Primary navigation', () => {
    const host = render(createElement(Sidebar));
    const aside = host.querySelector('#app-nav');
    expect(aside?.getAttribute('role')).toBe('complementary');
    expect(aside?.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
  });

  test('the top bar names the breadcrumb and the icon buttons', () => {
    const host = render(createElement(Topbar));
    expect(host.querySelector('header nav[aria-label="Breadcrumb"]')).not.toBeNull();
    const names = [...host.querySelectorAll('button, a')].map((el) =>
      el.getAttribute('aria-label')
    );
    expect(names).toEqual(
      expect.arrayContaining(['Open navigation', 'Open command palette', 'Alerts'])
    );
  });
});

describe('Breadcrumb', () => {
  test('starts at the active connection profile, not a product name', () => {
    useConnectionStore.setState({
      profiles: initial.profiles.map((profile) => ({ ...profile, name: 'Staging EU' })),
    });
    const host = render(createElement(Breadcrumb, { pathname: '/jobs' }));
    const crumbs = [...host.querySelectorAll('li:not([aria-hidden])')].map((li) => li.textContent);
    expect(crumbs).toEqual(['Staging EU', 'Work', 'Jobs']);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/');
  });
});

describe('Topbar theme toggle', () => {
  test('names the mode you switch to, in sentence case, and flips it', async () => {
    useThemeStore.setState({ theme: 'dark' });
    const host = render(createElement(Topbar));
    const button = () =>
      host.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]') as HTMLButtonElement;
    expect(button().getAttribute('aria-label')).toBe('Switch to light mode');
    act(() => button().click());
    await settle(1);
    expect(button().getAttribute('aria-label')).toBe('Switch to dark mode');
  });
});

describe('UserBlock', () => {
  test('shows only the role when nobody is signed in, and no sign-out', () => {
    const host = render(createElement(UserBlock));
    expect(host.textContent).toBe('OPOperator');
    expect(host.querySelector('button')).toBeNull();
  });

  test('a viewer is labelled as one', () => {
    useCapabilitiesStore.setState({ status: 'ready', caps: FAIL_CLOSED, error: null, key: 't' });
    expect(render(createElement(UserBlock)).textContent).toContain('Viewer');
  });

  test('a managed, ready session shows its subject and a keyboard-reachable Sign out', () => {
    let signedOut = 0;
    setActiveSession({ signOut: async () => void (signedOut += 1) } as never);
    act(() => useAuthStore.getState().setReady('ada@example.test'));
    const host = render(createElement(UserBlock));
    expect(host.textContent).toContain('ada@example.test');
    expect(host.textContent).toContain('Operator');
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Sign out"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.tabIndex).toBe(0);
    act(() => button?.click());
    expect(signedOut).toBe(1);
  });

  test('a managed session that is not ready offers no Sign out', () => {
    act(() => useAuthStore.getState().setSignedOut());
    expect(render(createElement(UserBlock)).querySelector('button')).toBeNull();
  });
});
