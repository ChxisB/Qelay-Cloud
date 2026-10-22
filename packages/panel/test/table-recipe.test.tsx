import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Table, Td, Th, THead, Tr, type RowStatus } from '../src/components/ui/Table';
import { ensureDom } from './domSetup';

const mounted: Array<() => void> = [];

function row(props: { status?: RowStatus; selected?: boolean; dense?: boolean } = {}): HTMLElement {
  const element: ReactElement = createElement(
    Table,
    {},
    createElement(
      'tbody',
      {},
      createElement(Tr, props, createElement(Td, {}, 'a'), createElement(Td, {}, 'b'))
    )
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host.querySelector('tr') as HTMLElement;
}

// Assembled from parts: Tailwind scans test/ too, and a literal would emit a dead utility.
const rc = (v: string) => ['[--rc:', v, ']'].join('');
const bg = (v: string) => ['[--row-bg:', v, ']'].join('');

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('table row recipe', () => {
  test('a plain row has no bar and no wash', () => {
    const tr = row();
    expect(tr.classList.contains(rc('transparent'))).toBe(true);
    expect(tr.classList.contains(bg('transparent'))).toBe(true);
  });

  test('hover is the neutral wash on every row, whatever its state', () => {
    for (const props of [{}, { selected: true }, { status: 'bad' as const }]) {
      expect(row(props).className).toContain(
        'hover:bg-[linear-gradient(var(--hover),var(--hover))]'
      );
    }
  });

  test('selected is the coral wash plus the highlight bar', () => {
    const tr = row({ selected: true });
    expect(tr.classList.contains(rc('var(--hl)'))).toBe(true);
    expect(tr.classList.contains(bg('var(--selected)'))).toBe(true);
  });

  test.each(['bad', 'warn', 'active', 'idle'] as const)(
    'status %s draws its bar and no wash',
    (status) => {
      const tr = row({ status });
      expect(tr.classList.contains(rc(`var(--${status})`))).toBe(true);
      expect(tr.classList.contains(bg('transparent'))).toBe(true);
    }
  );

  test('selected wins over a status, so a chosen row always looks chosen', () => {
    const tr = row({ selected: true, status: 'bad' });
    expect(tr.classList.contains(rc('var(--hl)'))).toBe(true);
    expect(tr.classList.contains(rc('var(--bad)'))).toBe(false);
  });

  test('the bar is drawn on the first cell, and the text stays on the foreground colour', () => {
    const tr = row({ selected: true });
    expect(tr.className).toContain('[&>:first-child]:shadow-[inset_3px_0_0_var(--rc)]');
    for (const td of tr.querySelectorAll('td')) expect(td.classList.contains('text-fg')).toBe(true);
  });

  test('dense rows are shorter than default rows', () => {
    expect(row({ dense: true }).classList.contains('h-9')).toBe(true);
    expect(row().classList.contains('h-10')).toBe(true);
  });
});

describe('table header', () => {
  test('header cells are column headers, so cells stay associated with them', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(
          Table,
          {},
          createElement(THead, {}, createElement('tr', {}, createElement(Th, {}, 'Name')))
        )
      )
    );
    mounted.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    expect(host.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(host.querySelector('table')?.tagName).toBe('TABLE');
  });

  test('sticky pins the header cells and the default does not', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(
          'div',
          {},
          createElement('table', {}, createElement(THead, { sticky: true })),
          createElement('table', {}, createElement(THead, {}))
        )
      )
    );
    mounted.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    const [pinned, plain] = [...host.querySelectorAll('thead')];
    expect(pinned?.className).toContain('[&_th]:sticky');
    expect(plain?.className ?? '').not.toContain('sticky');
  });
});
