import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ActionMenu, type ActionItem } from '../src/components/ui/ActionMenu';
import { ensureDom, settle } from './domSetup';

const mounted: Array<() => void> = [];

function render(items: ActionItem[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(MemoryRouter, null, createElement(ActionMenu, { label: 'More for x', items }))
    )
  );
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = host.querySelector('button') as HTMLButtonElement;
  return {
    host,
    button,
    menu: () => host.querySelector('[role="menu"]'),
    items: () => Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]')),
  };
}

const key = (name: string) =>
  act(() => {
    document.activeElement?.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: name, bubbles: true })
    );
  });
const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('ActionMenu', () => {
  test('the button names the menu, is closed at first and opens on a click with focus on the first item', () => {
    const m = render([
      { label: 'Events', to: '/events' },
      { label: 'Remove', danger: true },
    ]);
    expect(m.button.getAttribute('aria-label')).toBe('More for x');
    expect(m.button.getAttribute('aria-haspopup')).toBe('menu');
    expect(m.button.getAttribute('aria-expanded')).toBe('false');
    expect(m.menu()).toBeNull();
    click(m.button);
    expect(m.button.getAttribute('aria-expanded')).toBe('true');
    expect(m.menu()?.getAttribute('aria-label')).toBe('More for x');
    expect(m.items().map((el) => el.textContent)).toEqual(['Events', 'Remove']);
    expect(document.activeElement).toBe(m.items()[0]);
  });

  test('arrows wrap, Home and End jump', () => {
    const m = render([
      { label: 'A', onSelect() {} },
      { label: 'B', onSelect() {} },
      { label: 'C', onSelect() {} },
    ]);
    click(m.button);
    key('ArrowDown');
    expect(document.activeElement).toBe(m.items()[1]);
    key('End');
    expect(document.activeElement).toBe(m.items()[2]);
    key('ArrowDown');
    expect(document.activeElement).toBe(m.items()[0]);
    key('ArrowUp');
    expect(document.activeElement).toBe(m.items()[2]);
    key('Home');
    expect(document.activeElement).toBe(m.items()[0]);
  });

  test('Escape closes it and gives focus back to the button', async () => {
    const m = render([{ label: 'A', onSelect() {} }]);
    click(m.button);
    key('Escape');
    await act(() => settle(260));
    expect(m.menu()).toBeNull();
    expect(m.button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(m.button);
  });

  test('picking an action closes the menu and calls it once', async () => {
    const calls: string[] = [];
    const m = render([{ label: 'Remove', danger: true, onSelect: () => calls.push('remove') }]);
    click(m.button);
    click(m.items()[0]);
    expect(calls).toEqual(['remove']);
    await act(() => settle(260));
    expect(m.menu()).toBeNull();
  });

  test('a disabled item stays reachable by arrow, says why, and does nothing', () => {
    const calls: string[] = [];
    const m = render([
      {
        label: 'Test',
        disabled: true,
        hint: 'Turn it on first',
        onSelect: () => calls.push('test'),
      },
      { label: 'Events', to: '/events' },
    ]);
    click(m.button);
    const [test] = m.items();
    expect(test?.getAttribute('aria-disabled')).toBe('true');
    expect(test?.getAttribute('title')).toBe('Turn it on first');
    expect(document.activeElement).toBe(test);
    click(test);
    expect(calls).toEqual([]);
    expect(m.menu()).not.toBeNull();
  });

  test('a link item is a link, and a press outside closes the menu', async () => {
    const m = render([{ label: 'Events', to: '/events' }]);
    click(m.button);
    expect(m.items()[0]?.getAttribute('href')).toBe('/events');
    act(() => {
      document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await act(() => settle(260));
    expect(m.menu()).toBeNull();
  });

  test('a removal is set apart by a rule and drawn red', () => {
    const m = render([
      { label: 'Events', to: '/events' },
      { label: 'Remove', danger: true, onSelect() {} },
    ]);
    click(m.button);
    const [events, remove] = m.items();
    expect(events?.parentElement?.className).not.toContain('border-t');
    expect(remove?.parentElement?.className).toContain('border-t');
    expect(remove?.className).toContain('text-danger');
  });
});
