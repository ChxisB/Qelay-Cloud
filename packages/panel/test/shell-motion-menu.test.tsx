import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
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

describe('theme toggle', () => {
  test('both icons stay in the button and the shown one is the mode you switch to', () => {
    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(Topbar))
    );
    const button = host.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]');
    const icons = Array.from(button?.querySelectorAll<HTMLElement>(':scope > span') ?? []);
    expect(icons).toHaveLength(2);
    const shown = icons.filter((icon) => icon.style.opacity === '1');
    expect(shown).toHaveLength(1);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
    const before = button?.getAttribute('aria-label');
    act(() => button?.click());
    expect(button?.getAttribute('aria-label')).not.toBe(before);
    expect(icons.filter((icon) => icon.style.opacity === '1')[0]).not.toBe(shown[0]);
  });
});

describe('phone menu', () => {
  test('the drawer slides in at the enter time and out at the exit time', () => {
    const { host } = sidebarAt('/', { open: true });
    const drawer = host.querySelector('#app-nav');
    expect(drawer?.className).toContain('duration-(--dur-enter)');
    expect(drawer?.className).not.toContain('duration-(--dur-exit)');
    const closed = sidebarAt('/');
    const rest = closed.host.querySelector('#app-nav');
    expect(rest?.className).toContain('duration-(--dur-exit)');
    expect(rest?.className).toContain('ease-exit');
  });

  test('the scrim fades in, fades out for the exit time, then goes', async () => {
    const view = (open: boolean) =>
      createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(Sidebar, { open }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(view(true)));
    const scrim = () => host.querySelector('button[aria-label="Close navigation"]');
    expect(scrim()?.className).toContain('motion-fade');
    expect(scrim()?.className).not.toContain('motion-fade-out');

    act(() => root.render(view(false)));
    expect(scrim()?.className).toContain('motion-fade-out');
    expect(scrim()?.className).toContain('pointer-events-none');

    await settle(260);
    expect(scrim()).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
