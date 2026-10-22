import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ConnectionBadge } from '../src/components/layout/ConnectionBadge';
import { Sidebar } from '../src/components/layout/Sidebar';
import { Topbar } from '../src/components/layout/Topbar';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { NAV_GROUPS_STORAGE_KEY } from '../src/lib/useNavGroups';
import { settle } from './domSetup';

// Motion the shell adds: the sliding highlight, the group fold, the health flash and line, the Alerts count
// and the phone menu's timings. happy-dom has no layout and plays no animation, so the highlight is checked
// with a stubbed measurement, and the rest by the classes and nodes that carry the motion.

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

const sidebarAt = (path: string, props: { open?: boolean } = {}) =>
  render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Sidebar, props)));

function toggleFor(host: HTMLElement, section: string): HTMLButtonElement {
  const button = Array.from(
    host.querySelectorAll<HTMLButtonElement>('nav button[aria-expanded]')
  ).find((candidate) => candidate.textContent?.startsWith(section));
  if (!button) throw new Error(`no toggle for ${section}`);
  return button;
}

const breach = (n: number) => ({
  ruleId: `r${n}`,
  ruleName: `Rule ${n}`,
  metricLabel: 'Waiting',
  operator: '>' as const,
  threshold: 1,
  value: 2,
  queue: 'emails',
  at: n,
});

beforeEach(() => {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 'test',
  });
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  useAlertRuntimeStore.setState({ breaching: [] });
  // The health badge polls /health; a request that never settles keeps it quiet.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
  useAlertRuntimeStore.setState({ breaching: [] });
});

describe('sidebar highlight', () => {
  test('without a layout each row washes itself and no highlight is drawn', () => {
    const { host } = sidebarAt('/queues');
    const current = host.querySelector('nav a[aria-current="page"]');
    expect(current?.textContent).toBe('Queues');
    expect(current?.className).toContain('bg-selected');
    expect(host.querySelector('.nav-ind')).toBeNull();
    expect(host.querySelector('nav')?.hasAttribute('data-nav-slide')).toBe(false);
  });

  describe('with a layout', () => {
    const proto = () => window.HTMLElement.prototype;
    let top: PropertyDescriptor | undefined;
    let height: PropertyDescriptor | undefined;
    beforeEach(() => {
      top = Object.getOwnPropertyDescriptor(proto(), 'offsetTop');
      height = Object.getOwnPropertyDescriptor(proto(), 'offsetHeight');
      // A row sits 33px below the one before it, 32px tall.
      Object.defineProperty(proto(), 'offsetTop', {
        configurable: true,
        get(this: HTMLElement) {
          const links = Array.from(this.closest('nav')?.querySelectorAll('a') ?? []);
          return links.indexOf(this as HTMLAnchorElement) * 33;
        },
      });
      Object.defineProperty(proto(), 'offsetHeight', {
        configurable: true,
        get: () => 32,
      });
    });
    afterEach(() => {
      for (const [name, descriptor] of [
        ['offsetTop', top],
        ['offsetHeight', height],
      ] as const) {
        if (descriptor) Object.defineProperty(proto(), name, descriptor);
        else delete (proto() as unknown as Record<string, unknown>)[name];
      }
    });

    test('one highlight sits on the current row and the row keeps aria-current', () => {
      const { host } = sidebarAt('/queues');
      const current = host.querySelector<HTMLElement>('nav a[aria-current="page"]');
      const ind = host.querySelector<HTMLElement>('.nav-ind');
      expect(ind).not.toBeNull();
      expect(ind?.getAttribute('aria-hidden')).toBe('true');
      expect(ind?.style.transform).toBe(`translateY(${current?.offsetTop}px)`);
      expect(ind?.style.height).toBe('32px');
      expect(host.querySelector('nav')?.hasAttribute('data-nav-slide')).toBe(true);
      expect(host.querySelectorAll('.nav-ind')).toHaveLength(1);
    });

    test('going to another page moves the same highlight element', () => {
      const { host } = sidebarAt('/queues');
      const ind = host.querySelector<HTMLElement>('.nav-ind');
      const before = ind?.style.transform;
      const jobs = Array.from(host.querySelectorAll<HTMLAnchorElement>('nav a')).find(
        (a) => a.textContent === 'Jobs'
      );
      act(() => jobs?.click());
      expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Jobs');
      expect(host.querySelector('.nav-ind')).toBe(ind);
      expect(ind?.style.transform).not.toBe(before);
    });

    test('a current page inside a folded group has no highlight, and the group says so', () => {
      const { host } = sidebarAt('/queues');
      act(() => toggleFor(host, 'Work').click());
      expect(host.querySelector('nav a[aria-current="page"]')).toBeNull();
      expect(host.querySelector('.nav-ind')).toBeNull();
      const work = toggleFor(host, 'Work');
      expect(work.textContent).toContain('contains the current page');
      expect(work.querySelector('.bg-hl')?.getAttribute('aria-hidden')).toBe('true');
    });
  });
});

describe('group fold', () => {
  test('a group opened by hand fades its pages in one after another; the first paint does not', () => {
    const { host } = sidebarAt('/queues');
    const open = toggleFor(host, 'Work');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const workPanel = document.getElementById(open.getAttribute('aria-controls') ?? '');
    expect(workPanel?.className).not.toContain('motion-stagger');

    const monitor = toggleFor(host, 'Monitor');
    expect(monitor.getAttribute('aria-expanded')).toBe('false');
    act(() => monitor.click());
    const panel = document.getElementById(monitor.getAttribute('aria-controls') ?? '');
    expect(panel?.className).toContain('motion-stagger');
    const rows = Array.from(panel?.children ?? []) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((row) => row.style.getPropertyValue('--i'))).toEqual(
      rows.map((_, i) => String(i))
    );
  });

  test('a folded group shows its page count as a pill, and unfolding drops it', () => {
    const { host } = sidebarAt('/queues');
    const monitor = toggleFor(host, 'Monitor');
    expect(monitor.querySelector('.rounded-full')?.textContent).toBe('5');
    act(() => monitor.click());
    expect(toggleFor(host, 'Monitor').querySelector('.rounded-full')).toBeNull();
  });
});

describe('health badge', () => {
  let answer: () => Response;
  const poll = async () => {
    act(() => document.dispatchEvent(new window.Event('visibilitychange')));
    await settle(10);
  };
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://localhost:4000' });
    answer = () => Response.json({ ok: true });
    globalThis.fetch = (() => Promise.resolve(answer())) as unknown as typeof fetch;
  });

  test('the first answer is quiet: no flash and nothing spoken', async () => {
    const { host } = render(createElement(ConnectionBadge));
    await settle(10);
    expect(host.textContent).toContain('Healthy');
    expect(host.querySelector('.motion-flash')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });

  test('a poll that moves the state flashes once and says it; the same state again does nothing', async () => {
    const { host } = render(createElement(ConnectionBadge));
    await settle(10);
    const status = host.querySelector('[role="status"]');

    answer = () => Response.json({ ok: false, status: 'degraded' }, { status: 503 });
    await poll();
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe('Control API is reachable but degraded.');
    const flash = host.querySelector('.motion-flash');
    expect(flash?.textContent).toBe('Degraded');
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(1);

    await poll();
    expect(host.querySelector('.motion-flash')).toBe(flash);
    expect(status?.textContent).toBe('Control API is reachable but degraded.');

    answer = () => Response.json({ ok: true });
    await poll();
    expect(status?.textContent).toBe('Control API is healthy.');
    expect(host.querySelector('.motion-flash')).not.toBe(flash);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(1);
  });
});

describe('Alerts link', () => {
  const topbar = () =>
    render(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(Topbar)));
  const alertsLink = (host: HTMLElement) =>
    host.querySelector<HTMLAnchorElement>('a[href="/alerts"]');

  test('with nothing triggered it is named Alerts and has no dot', () => {
    const { host } = topbar();
    expect(alertsLink(host)?.getAttribute('aria-label')).toBe('Alerts');
    expect(alertsLink(host)?.querySelector('.bg-hl')).toBeNull();
  });

  test('with breaches it carries the count in its name and a dot, from the store the panel already polls', () => {
    useAlertRuntimeStore.setState({ breaching: [breach(1), breach(2), breach(3)] });
    const { host } = topbar();
    expect(alertsLink(host)?.getAttribute('aria-label')).toBe('Alerts, 3 triggered');
    expect(alertsLink(host)?.getAttribute('title')).toBe('Alerts, 3 triggered');
    expect(alertsLink(host)?.querySelector('.bg-hl')?.getAttribute('aria-hidden')).toBe('true');
    act(() => useAlertRuntimeStore.setState({ breaching: [] }));
    expect(alertsLink(host)?.getAttribute('aria-label')).toBe('Alerts');
    expect(alertsLink(host)?.querySelector('.bg-hl')).toBeNull();
  });
});
