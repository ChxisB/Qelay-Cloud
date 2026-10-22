import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { FlowKindTabs } from '../src/components/FlowKindTabs';
import { Sidebar } from '../src/components/layout/Sidebar';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { NAV_GROUPS_STORAGE_KEY } from '../src/lib/useNavGroups';
import { ensureDom } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function mount(path: string, element: ReactElement) {
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

const serve = (features: Partial<typeof DEMO_CAPABILITIES.features>) =>
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: { ...DEMO_CAPABILITIES, features: { ...DEMO_CAPABILITIES.features, ...features } },
    error: null,
    key: 'test',
  });

const flowLinks = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Primary"] a')).filter((a) =>
    ['/flows', '/workflows'].includes(a.getAttribute('href') ?? '')
  );

beforeEach(() => {
  serve({ flows: true, workflows: true });
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  serve({});
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
});

describe('Flows: one item for job flows and workflow runs', () => {
  test('the sidebar has one link, and it is the current page on both of them', () => {
    for (const path of ['/flows', '/workflows']) {
      const links = flowLinks(mount(path, createElement(Sidebar)));
      expect(
        links.map((a) => a.getAttribute('href')),
        path
      ).toEqual(['/flows']);
      expect(links[0]?.getAttribute('aria-current'), path).toBe('page');
      expect(links[0]?.textContent).toContain('Flows');
    }
  });

  test('with only workflows served, the one link goes to the workflow runs', () => {
    serve({ flows: false, workflows: true });
    const links = flowLinks(mount('/workflows', createElement(Sidebar)));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/workflows']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
  });

  test('with neither served, there is no link', () => {
    serve({ flows: false, workflows: false });
    expect(flowLinks(mount('/', createElement(Sidebar)))).toEqual([]);
  });
});

describe('FlowKindTabs', () => {
  test('offers both kinds and marks the open one', () => {
    const host = mount('/workflows', createElement(FlowKindTabs, { current: 'workflows' }));
    const links = Array.from(host.querySelectorAll('nav[aria-label="Kind of flow"] a'));
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/flows', 'Job flows'],
      ['/workflows', 'Workflow runs'],
    ]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page']);
  });

  test('shows nothing when the server offers only one kind', () => {
    serve({ flows: true, workflows: false });
    const host = mount('/flows', createElement(FlowKindTabs, { current: 'jobs' }));
    expect(host.querySelector('nav')).toBeNull();
  });
});
