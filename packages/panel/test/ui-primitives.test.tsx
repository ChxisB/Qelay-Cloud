import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, IconButton } from '../src/components/ui/Button';
import { ErrorState } from '../src/components/ui/feedback';
import { SegmentedControl } from '../src/components/ui/form';
import { Kbd } from '../src/components/ui/Kbd';
import { SearchField } from '../src/components/ui/SearchField';
import { StatCard } from '../src/components/ui/StatCard';
import { ensureDom } from './domSetup';

// Assembled from a variable: Tailwind scans test/ too, and a literal here would emit a dead utility.
const WHITE = ['text', 'white'].join('-');
const mounted: Array<() => void> = [];

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  mounted.push(unmount);
  return { host, unmount };
}

function click(el: Element | null | undefined) {
  act(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

beforeEach(() => ensureDom());

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('Button', () => {
  function classesOf(element: ReactElement): DOMTokenList {
    const { host } = render(element);
    return (host.firstElementChild as HTMLElement).classList;
  }

  test('every variant is 10px-radius, semibold and shares the focus outline', () => {
    for (const variant of ['default', 'ghost', 'primary', 'danger'] as const) {
      const cls = classesOf(createElement(Button, { variant }, variant));
      expect(cls.contains('rounded-control')).toBe(true);
      expect(cls.contains('font-semibold')).toBe(true);
      expect(cls.contains('focus-visible:outline-ring')).toBe(true);
    }
  });

  test('md is 36px / 13px and sm is 32px / 12px', () => {
    const md = classesOf(createElement(Button, {}, 'Save'));
    expect(md.contains('h-9')).toBe(true);
    expect(md.contains('text-[13px]')).toBe(true);
    const sm = classesOf(createElement(Button, { size: 'sm' }, 'Save'));
    expect(sm.contains('h-8')).toBe(true);
    expect(sm.contains('text-xs')).toBe(true);
  });

  test('primary is the solid fill with its own foreground, never white text', () => {
    const cls = classesOf(createElement(Button, { variant: 'primary' }, 'Run'));
    expect(cls.contains('bg-primary')).toBe(true);
    expect(cls.contains('text-primary-fg')).toBe(true);
    expect(cls.contains(WHITE)).toBe(false);
  });

  test('danger is an outline in the danger colour, not a fill', () => {
    const cls = classesOf(createElement(Button, { variant: 'danger' }, 'Stop'));
    expect(cls.contains('text-danger')).toBe(true);
    expect(cls.contains('border-danger/45')).toBe(true);
    expect([...cls].some((c) => /^bg-(danger|red)/.test(c))).toBe(false);
  });

  test('default is a bordered, transparent button that gets a surface in light', () => {
    const cls = classesOf(createElement(Button, {}, 'Cancel'));
    expect(cls.contains('border-line-strong')).toBe(true);
    expect(cls.contains('bg-transparent')).toBe(true);
    expect(cls.contains('light:bg-surface')).toBe(true);
  });

  test('disabled drops to 0.4 and blocks clicks while keeping the title tooltip reachable', () => {
    let clicks = 0;
    const { host } = render(
      createElement(
        Button,
        { disabled: true, title: 'Nothing to save', onClick: () => clicks++ },
        'Save'
      )
    );
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('disabled:opacity-40')).toBe(true);
    expect(button.classList.contains('disabled:cursor-not-allowed')).toBe(true);
    // pointer-events-none would also swallow the native title tooltip
    expect(button.className).not.toContain('pointer-events-none');
    expect(button.title).toBe('Nothing to save');
    click(button);
    expect(clicks).toBe(0);
  });

  test('IconButton shares the control radius and the disabled treatment', () => {
    const cls = classesOf(createElement(IconButton, { 'aria-label': 'Close' }, '×'));
    expect(cls.contains('size-8')).toBe(true);
    expect(cls.contains('rounded-control')).toBe(true);
    expect(cls.contains('disabled:opacity-40')).toBe(true);
  });
});

describe('StatCard', () => {
  test('the red tone is the attention tile: danger border, dot beside the label', () => {
    const { host } = render(createElement(StatCard, { label: 'Failed', value: 3, tone: 'red' }));
    const card = host.firstElementChild as HTMLElement;
    expect(card.classList.contains('border-danger/40')).toBe(true);
    expect(card.classList.contains('rounded-card')).toBe(true);
    const dot = card.querySelector('span[aria-hidden="true"]');
    expect(dot?.classList.contains('bg-danger-fill')).toBe(true);
    expect(card.textContent).toBe('Failed3');
  });

  test('other tones keep the neutral border and have no dot', () => {
    for (const tone of ['default', 'green', 'blue', 'amber', 'link'] as const) {
      const { host } = render(createElement(StatCard, { label: 'Active', value: 1, tone }));
      const card = host.firstElementChild as HTMLElement;
      expect(card.classList.contains('border-line')).toBe(true);
      expect(card.classList.contains('border-danger/40')).toBe(false);
      expect(card.querySelector('[aria-hidden="true"]')).toBeNull();
    }
  });

  test('the value is the 32px tabular figure, with a muted hint under it', () => {
    const { host } = render(createElement(StatCard, { label: 'Waiting', value: 12, hint: 'now' }));
    const [label, value, hint] = Array.from(host.firstElementChild?.children ?? []);
    expect(label?.classList.contains('eyebrow')).toBe(true);
    expect(value?.classList.contains('text-[32px]')).toBe(true);
    expect(value?.classList.contains('tnum')).toBe(true);
    expect(hint?.textContent).toBe('now');
    expect(hint?.classList.contains('text-muted')).toBe(true);
  });

  test('compact shrinks the value and padding', () => {
    const { host } = render(
      createElement(StatCard, { label: 'Waiting', value: 12, compact: true })
    );
    const card = host.firstElementChild as HTMLElement;
    expect(card.classList.contains('px-4')).toBe(true);
    expect(card.children[1]?.classList.contains('text-xl')).toBe(true);
    expect(card.children[1]?.classList.contains('text-[32px]')).toBe(false);
  });
});

describe('SearchField and Kbd', () => {
  test('Kbd is a semantic kbd chip', () => {
    const { host } = render(createElement(Kbd, {}, '⌘K'));
    const kbd = host.querySelector('kbd');
    expect(kbd?.textContent).toBe('⌘K');
    expect(kbd?.classList.contains('rounded-kbd')).toBe(true);
  });

  test('forwards input props, so it works controlled and keeps its accessible name', () => {
    function Harness() {
      const [value, setValue] = useState('boom');
      return createElement(SearchField, {
        value,
        onChange: (e: { target: { value: string } }) => setValue(e.target.value),
        placeholder: 'Search…',
        'aria-label': 'Search logs',
      });
    }
    const { host } = render(createElement(Harness));
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('boom');
    expect(input.placeholder).toBe('Search…');
    expect(input.getAttribute('aria-label')).toBe('Search logs');
  });

  test('the wrapper owns the border and the focus ring, the bare input none', () => {
    const { host } = render(createElement(SearchField, { 'aria-label': 'Search' }));
    const wrapper = host.firstElementChild as HTMLElement;
    expect(wrapper.classList.contains('rounded-control')).toBe(true);
    expect(wrapper.classList.contains('h-9')).toBe(true);
    expect(wrapper.classList.contains('focus-within:outline-ring')).toBe(true);
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('kbd')).toBeNull();
  });

  test('className reaches the input, containerClassName the wrapper, shortcut adds the chip', () => {
    const { host } = render(
      createElement(SearchField, {
        'aria-label': 'Search',
        className: 'font-mono',
        containerClassName: 'w-64',
        shortcut: '/',
      })
    );
    expect(host.querySelector('input')?.classList.contains('font-mono')).toBe(true);
    expect((host.firstElementChild as HTMLElement).classList.contains('w-64')).toBe(true);
    expect(host.querySelector('kbd')?.textContent).toBe('/');
  });
});

describe('SegmentedControl format', () => {
  test('shows the formatted label while onChange still receives the raw option', () => {
    const picked: string[] = [];
    const { host } = render(
      createElement(SegmentedControl, {
        options: ['active', 'archive'] as const,
        value: 'active',
        onChange: (v: string) => picked.push(v),
        label: 'Store',
        format: (v: string) => (v === 'archive' ? 'archive (4)' : v),
      })
    );
    const buttons = host.querySelectorAll('button');
    expect(buttons[0]?.textContent).toBe('active');
    expect(buttons[1]?.textContent).toBe('archive (4)');
    click(buttons[1]);
    expect(picked).toEqual(['archive']);
  });

  test('the active segment is raised and bold, inactive ones are muted', () => {
    const { host } = render(
      createElement(SegmentedControl, {
        options: ['data', 'schema'] as const,
        value: 'schema',
        onChange: () => {},
      })
    );
    const [data, schema] = Array.from(host.querySelectorAll('button'));
    expect(schema?.classList.contains('bg-segment-active')).toBe(true);
    expect(schema?.classList.contains('font-semibold')).toBe(true);
    expect(data?.classList.contains('text-muted')).toBe(true);
    expect(data?.classList.contains('bg-segment-active')).toBe(false);
  });
});

describe('ErrorState retry', () => {
  test('is a regular small Button and fires onRetry', () => {
    let retries = 0;
    const { host } = render(
      createElement(ErrorState, { error: new Error('down'), onRetry: () => retries++ })
    );
    const retry = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry'
    );
    expect(retry?.classList.contains('rounded-control')).toBe(true);
    expect(retry?.classList.contains('h-8')).toBe(true);
    click(retry);
    expect(retries).toBe(1);
  });
});
