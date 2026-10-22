import { beforeEach } from 'bun:test';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { toast, useToastStore } from '../src/components/dashboard/stores/toastStore';
import { Toaster } from '../src/components/ui/Toaster';
import { RowDetailDrawer } from '../src/pages/control/database/RowDetailDrawer';
import {
  act,
  CommandPalette,
  createElement,
  describe,
  expect,
  installTestHooks,
  MemoryRouter,
  render,
  settle,
  test,
} from './frontend-a11y-fixes.helpers';

// What an overlay does on the way in and the way out: a toast, the palette and the row drawer. happy-dom plays
// no animation, so this checks the classes that carry it, when a leaving surface goes away, and that a leaving
// surface no longer answers. The exit is 180ms (usePresence, useLeavers), so a test waits 260ms for it.

installTestHooks();

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

const cards = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>('section[aria-label="Notifications"] > *'));
const key = (name: string) =>
  act(() =>
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))
  );

describe('a toast', () => {
  test('arrives with the rise, and on dismissal leaves where it stood before it goes', async () => {
    const { host } = render(createElement(Toaster));
    let first = 0;
    act(() => {
      first = toast.success('Saved');
      toast.info('Synced');
    });
    expect(cards(host).map((card) => card.className.includes('motion-arrive'))).toEqual([
      true,
      true,
    ]);

    act(() => useToastStore.getState().dismiss(first));
    const [leaving, staying] = cards(host);
    expect(cards(host)).toHaveLength(2);
    expect(leaving?.textContent).toContain('Saved');
    expect(leaving?.className).toContain('motion-leave');
    expect(leaving?.hasAttribute('inert')).toBe(true);
    expect(staying?.textContent).toContain('Synced');
    expect(staying?.className).not.toContain('motion-leave');

    await settle(260);
    expect(cards(host).map((card) => card.textContent)).toEqual([
      expect.stringContaining('Synced'),
    ]);
  });

  test('leaves at once under reduced motion', async () => {
    const real = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      const { host } = render(createElement(Toaster));
      let id = 0;
      act(() => {
        id = toast.success('Saved');
      });
      act(() => useToastStore.getState().dismiss(id));
      expect(cards(host)).toHaveLength(0);
    } finally {
      window.matchMedia = real;
    }
  });
});

describe('the command palette', () => {
  test('plays its exit on Escape, then unmounts', async () => {
    const { host } = render(createElement(MemoryRouter, null, createElement(CommandPalette)));
    act(() => window.dispatchEvent(new window.Event('command-palette:open')));
    await settle(5);
    const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog()?.className).toContain('motion-drop');

    key('Escape');
    expect(dialog()?.className).toContain('motion-leave');
    expect(dialog()?.parentElement?.className).toContain('pointer-events-none');
    expect(dialog()?.parentElement?.hasAttribute('inert')).toBe(true);
    await settle(260);
    expect(dialog()).toBeNull();
  });
});

describe('the row drawer', () => {
  const drawer = (leaving: boolean) =>
    createElement(RowDetailDrawer, {
      table: 'jobs',
      columns: ['id'],
      row: [1],
      rowid: 1,
      truncated: [false],
      leaving,
      onClose: () => undefined,
    });

  test('slides in and holds focus', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { host } = render(drawer(false));
    const aside = host.querySelector<HTMLElement>('aside');
    expect(aside?.className).toContain('motion-slide');
    expect(aside?.className).not.toContain('motion-slide-out');
    outside.focus();
    expect(aside?.contains(document.activeElement)).toBe(true);
    outside.remove();
  });

  test('slides out when it is leaving, and no longer answers or holds focus', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { host } = render(drawer(true));
    const aside = host.querySelector<HTMLElement>('aside');
    expect(aside?.className).toContain('motion-slide-out');
    expect(aside?.className).toContain('pointer-events-none');
    expect(host.querySelector('button[aria-label="Close row detail"]')?.className).toContain(
      'motion-fade-out'
    );
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('is out of reach while a confirm sits over it', () => {
    const { host } = render(drawer(false));
    expect(host.querySelector('aside')?.hasAttribute('inert')).toBe(false);
    act(() => {
      useGlobalModalStore.getState().request('database-row');
      useGlobalModalStore.getState().request('confirm');
    });
    expect(host.querySelector('aside')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('button[aria-label="Close row detail"]')?.hasAttribute('inert')).toBe(
      true
    );
  });
});
