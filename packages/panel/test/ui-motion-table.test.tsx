import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { buttonClass, iconButtonClass } from '../src/components/ui/Button';
import { Toggle } from '../src/components/ui/form';
import { Table, Tr } from '../src/components/ui/Table';
import { useFirstLoad } from '../src/lib/useFirstLoad';
import { ensureDom, renderHook } from './domSetup';

// What the shared feedback and data parts do when something arrives or changes. happy-dom plays no animation, so
// these check the classes that carry it, and above all what must NOT restart: an unchanged poll renders the same
// element, with the same key, and nothing flashes, redraws or slides.

const mounted: Array<() => void> = [];

/** Mounts once and re-renders into the same root, the way a poll does. */
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, again: (next: ReactElement) => act(() => root.render(next)) };
}

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const first = <T extends Element>(host: Element, selector: string) =>
  host.querySelector(selector) as T;

describe('a table', () => {
  const rows = (arrive: Array<number | undefined>) =>
    createElement(
      Table,
      null,
      createElement(
        'tbody',
        null,
        arrive.map((place, i) =>
          createElement(Tr, { key: i, arrive: place }, createElement('td', null, `row ${i}`))
        )
      )
    );
  const trs = (host: Element) => [...host.querySelectorAll<HTMLElement>('tr')];

  test('a row rises with its place in the first load; one without a place does not', () => {
    const { host } = mount(rows([0, 3, undefined]));
    const [a, b, c] = trs(host);
    expect(a?.className).toContain('motion-arrive');
    expect(a?.style.getPropertyValue('--i')).toBe('0');
    expect(b?.style.getPropertyValue('--i')).toBe('3');
    expect(c?.className).not.toContain('motion-arrive');
  });

  test('a row keeps its rise when the page stops passing it, so a poll cannot cut it short', () => {
    const { host, again } = mount(rows([0, 1]));
    const [a] = trs(host);
    again(rows([undefined, undefined]));
    expect(trs(host)[0]).toBe(a);
    expect(a?.className).toContain('motion-arrive');
  });

  test('a row that is not part of the first load never starts one later', () => {
    const { host, again } = mount(rows([undefined]));
    again(rows([2]));
    expect(trs(host)[0]?.className).not.toContain('motion-arrive');
  });

  test('useFirstLoad holds until the data is there, then lets go for good', () => {
    const hook = renderHook(useFirstLoad, false);
    expect(hook.result.current).toBe(true);
    hook.rerender(true);
    expect(hook.result.current).toBe(false);
    hook.rerender(false);
    expect(hook.result.current).toBe(false);
    hook.unmount();
  });
});

describe('a switch', () => {
  test('slides its thumb by transform, never by position, and keeps its state in aria-checked', () => {
    const noop = () => undefined;
    const { host, again } = mount(
      createElement(Toggle, { checked: false, onChange: noop, label: 'Rule' })
    );
    const thumb = () => host.querySelectorAll('button > span')[1] as HTMLElement;
    const button = first<HTMLElement>(host, 'button');
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(thumb().className).toContain('translate-x-0');

    again(createElement(Toggle, { checked: true, onChange: noop, label: 'Rule' }));
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(thumb().className).toContain('translate-x-4');
    expect(thumb().className).toContain('transition-[transform');
    expect(thumb().className).toContain('ease-pop');
    expect(thumb().className).not.toContain(['transition', '[left]'].join('-'));
  });
});

describe('a press', () => {
  test('a button and an icon button wash on hover and sink a hair on press, unless disabled', () => {
    for (const className of [buttonClass(), iconButtonClass()]) {
      expect(className).toContain('duration-(--duration-hover)');
      expect(className).toContain('enabled:active:duration-(--duration-press)');
      expect(className).toContain('enabled:active:scale-[0.97]');
    }
  });
});
