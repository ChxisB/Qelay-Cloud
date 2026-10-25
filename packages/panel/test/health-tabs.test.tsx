import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HealthTabs } from '../src/components/HealthTabs';
import { Sidebar } from '../src/components/layout/Sidebar';
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

const PAGES = ['/deployment', '/backups', '/diagnostics', '/transport', '/usage'] as const;

beforeEach(() => {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 't',
  });
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  // The sidebar's health badge polls: a request that never settles keeps it quiet.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
});

describe('Health: five reports, one sidebar item', () => {
  test('the tab bar links every report and marks the open one', () => {
    for (const open of PAGES) {
      const host = mount(open, createElement(HealthTabs, { current: open }));
      const links = [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Health"] a')];
      expect(links.map((a) => a.getAttribute('href'))).toEqual([...PAGES]);
      const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.getAttribute('href'))).toEqual([open]);
    }
  });

  test('the sidebar has one Health link, and it is the current page on all five', () => {
    for (const path of PAGES) {
      const host = mount(path, createElement(Sidebar));
      const links = [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Primary"] a')];
      expect(links.filter((a) => PAGES.includes(a.getAttribute('href') as never))).toHaveLength(1);
      const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.textContent)).toEqual(['Health']);
    }
  });
});
