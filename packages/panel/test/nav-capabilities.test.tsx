import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../src/components/layout/Sidebar';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES, FAIL_CLOSED } from '../src/lib/capabilities/types';
import { NAV_GROUPS_STORAGE_KEY } from '../src/lib/useNavGroups';
import { ensureDom } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function sidebarAt(path: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  act(() =>
    root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Sidebar)))
  );
  return { host, unmount };
}

function serve(caps: typeof DEMO_CAPABILITIES, status: 'ready' | 'loading' | 'error' = 'ready') {
  useCapabilitiesStore.setState({ status, caps, error: null, key: 'test' });
}

beforeEach(() => {
  serve(DEMO_CAPABILITIES);
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  // ConnectionBadge polls /health: a request that never settles keeps it quiet.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  serve(DEMO_CAPABILITIES, 'ready');
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
});

describe('Sidebar: what the deployment offers, and the header', () => {
  test('a deployment that closes server pages leaves them out, and an emptied group goes', () => {
    serve({
      ...DEMO_CAPABILITIES,
      hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet'],
      features: { dlq: true, cron: true, flows: false, workflows: false, webhooks: false },
    });
    const { host } = sidebarAt('/');
    for (const toggle of host.querySelectorAll<HTMLButtonElement>(
      'nav button[aria-expanded="false"]'
    )) {
      act(() => toggle.click());
    }
    const hrefs = Array.from(host.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
    for (const closed of [
      '/server',
      '/database',
      '/s3',
      '/fleet',
      '/flows',
      '/workflows',
      '/events-gateway',
    ]) {
      expect(hrefs).not.toContain(closed);
    }
    for (const kept of [
      '/',
      '/queues',
      '/jobs',
      '/dlq',
      '/cron',
      '/workers',
      '/deployment',
      // System stays while any of its pages is open, and links to the first one that is.
      '/mcp',
      '/settings',
    ]) {
      expect(hrefs).toContain(kept);
    }
    // Automation had Webhooks and Flows, both closed here: the group goes with them.
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('nav button[aria-expanded]')).some((b) =>
        b.textContent?.startsWith('Automation')
      )
    ).toBe(false);
  });

  test('until the server has answered, pages that can be closed are not offered', () => {
    serve(FAIL_CLOSED, 'loading');
    const { host } = sidebarAt('/');
    for (const toggle of host.querySelectorAll<HTMLButtonElement>(
      'nav button[aria-expanded="false"]'
    )) {
      act(() => toggle.click());
    }
    const hrefs = Array.from(host.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/server');
    expect(hrefs).not.toContain('/dlq');
    expect(hrefs).toContain('/queues');
    expect(hrefs).toContain('/settings');
  });

  test('the header is the Qelay lockup, not the old wordmark', () => {
    const { host } = sidebarAt('/');
    const text = host.textContent ?? '';
    expect(text).toContain('Qelay');
    expect(text).toContain('Cloud console');
    expect(text).not.toMatch(/bun.?queue/i);
  });
});
