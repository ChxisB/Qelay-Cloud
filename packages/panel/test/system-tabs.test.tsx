import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../src/components/layout/Sidebar';
import { SystemTabs } from '../src/components/SystemTabs';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { NAV_GROUPS_STORAGE_KEY } from '../src/lib/useNavGroups';
import { ensureDom } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function mount(path: string, element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.add(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, element)));
  return host;
}

const serve = (caps: typeof DEMO_CAPABILITIES) =>
  useCapabilitiesStore.setState({ status: 'ready', caps, error: null, key: 't' });

const ALL = ['/server', '/database', '/mcp', '/benchmark', '/fleet'] as const;
const tabHrefs = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="System"] a')].map((a) =>
    a.getAttribute('href')
  );

beforeEach(() => {
  serve(DEMO_CAPABILITIES);
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  // The sidebar's health badge polls: a request that never settles keeps it quiet.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  serve(DEMO_CAPABILITIES);
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
});

describe('System: five pages, one sidebar item', () => {
  test('the tab bar links every page and marks the open one', () => {
    for (const open of ALL) {
      const host = mount(open, createElement(SystemTabs, { current: open }));
      expect(tabHrefs(host)).toEqual([...ALL]);
      const current = [...host.querySelectorAll('nav[aria-label="System"] a[aria-current="page"]')];
      expect(current.map((a) => a.getAttribute('href'))).toEqual([open]);
    }
  });

  test('a page this deployment closes is left out of the tab bar, not shown failing', () => {
    serve({
      ...DEMO_CAPABILITIES,
      hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet'],
    });
    const host = mount('/mcp', createElement(SystemTabs, { current: '/mcp' }));
    expect(tabHrefs(host)).toEqual(['/mcp', '/benchmark']);
  });

  test('a viewer is not offered the Benchmark, and a lone page is not a switch', () => {
    serve({
      ...DEMO_CAPABILITIES,
      hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet'],
      principal: { ...DEMO_CAPABILITIES.principal, role: 'viewer' },
    });
    const host = mount('/mcp', createElement(SystemTabs, { current: '/mcp' }));
    expect(host.querySelector('nav[aria-label="System"]')).toBeNull();
  });

  test('the sidebar has one System link, and it is the current page on all five', () => {
    for (const path of ALL) {
      const host = mount(path, createElement(Sidebar));
      const links = [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Primary"] a')];
      expect(links.filter((a) => ALL.includes(a.getAttribute('href') as never))).toHaveLength(1);
      const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.textContent)).toEqual(['System']);
    }
  });
});
