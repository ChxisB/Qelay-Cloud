import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Td, Th } from '../src/components/ui/Table';
import type { QueueHealth } from '../src/pages/control/overview/model';
import { QueueHealthTable } from '../src/pages/control/overview/QueueHealthTable';
import { ensureDom } from './domSetup';

const mounted: Array<() => void> = [];

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, {}, element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const counts = (over: Partial<NonNullable<QueueHealth['counts']>> = {}) => ({
  waiting: 0,
  prioritized: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  ...over,
});
const queue = (name: string, over: Partial<QueueHealth> = {}): QueueHealth => ({
  name,
  paused: false,
  dlq: 0,
  counts: counts(),
  ...over,
});

// Assembled from parts: Tailwind scans test/ too, and a literal would emit a dead utility.
const bar = (v: string) => ['[--rc:var(--', v, ')]'].join('');

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('Overview queue health rows', () => {
  const rows = [
    queue('broken', { dlq: 3 }),
    queue('held', { paused: true }),
    queue('busy', { counts: counts({ active: 2 }) }),
    queue('quiet'),
    queue('blind', { counts: null, dlq: null }),
  ];

  function rowOf(host: HTMLElement, name: string): HTMLElement {
    const tr = [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name));
    return tr as HTMLElement;
  }

  test('every row names its state in a word, so the bar is not the only signal', () => {
    const host = render(createElement(QueueHealthTable, { rows, total: rows.length }));
    const word = (name: string) =>
      rowOf(host, name).querySelector('span.rounded-full')?.textContent;
    expect(word('broken')).toBe('Failing');
    expect(word('held')).toBe('Paused');
    expect(word('busy')).toBe('Active');
    expect(word('quiet')).toBe('Healthy');
    expect(word('blind')).toBe('Unknown');
  });

  test('the bar follows the state, and a healthy or unknown row has none', () => {
    const host = render(createElement(QueueHealthTable, { rows, total: rows.length }));
    expect(rowOf(host, 'broken').classList.contains(bar('bad'))).toBe(true);
    expect(rowOf(host, 'held').classList.contains(bar('idle'))).toBe(true);
    expect(rowOf(host, 'busy').classList.contains(bar('active'))).toBe(true);
    for (const name of ['quiet', 'blind']) {
      expect(rowOf(host, name).classList.contains('[--rc:transparent]'), name).toBe(true);
    }
  });

  test('a queue whose counts could not be read is never shown as healthy', () => {
    const host = render(
      createElement(QueueHealthTable, { rows: [rows[4] as QueueHealth], total: 1 })
    );
    expect(host.textContent).not.toContain('Healthy');
    expect(host.textContent).toContain('—');
  });

  test('header cells are column headers', () => {
    const host = render(createElement(QueueHealthTable, { rows, total: rows.length }));
    expect([...host.querySelectorAll('th')].every((th) => th.getAttribute('scope') === 'col')).toBe(
      true
    );
  });
});

describe('table cell padding', () => {
  test('a cell carries one side-padding rule: tight swaps it, nothing stacks', () => {
    const host = render(
      createElement(
        'table',
        {},
        createElement(
          'tbody',
          {},
          createElement(
            'tr',
            {},
            createElement(Td, {}, 'a'),
            createElement(Td, { tight: true }, 'b')
          )
        ),
        createElement('thead', {}, createElement('tr', {}, createElement(Th, { tight: true }, 'h')))
      )
    );
    const [plain, tight] = [...host.querySelectorAll('td')];
    expect(plain?.className).toContain('px-3');
    expect(plain?.className).not.toContain('px-1.5');
    expect(tight?.className).toContain('px-1.5 sm:px-3');
    expect(tight?.className.split(' ').includes('px-3')).toBe(false);
    expect(host.querySelector('th')?.className).toContain('px-1.5 sm:px-3');
  });
});
