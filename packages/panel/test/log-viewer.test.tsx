import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LogBox,
  LogChip,
  LogLine,
  LogSearch,
  type LogLevel,
  MiniLog,
} from '../src/components/ui/LogViewer';
import { ensureDom } from './domSetup';

const CSS = ['index', 'tokens']
  .map((n) => readFileSync(new URL(`../src/${n}.css`, import.meta.url), 'utf8'))
  .join('\n');
const mounted: Array<() => void> = [];

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

// The log tokens are defined once, in the first block, and not redefined for light: the viewer is
// a terminal in both themes. A second definition would let a theme switch change it.
const LOG = new Map(
  [...CSS.matchAll(/^\s*--(log-[\w-]+):\s*(#[0-9a-f]{6});/gim)].map((m) => [m[1], m[2]])
);

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (top: Rgb, under: Rgb, alpha: number): Rgb =>
  top.map((c, i) => c * alpha + (under[i] as number) * (1 - alpha)) as Rgb;
const tok = (name: string) => rgb(LOG.get(name) ?? '#000000');

describe('log token contrast', () => {
  test('the log tokens are defined once', () => {
    expect(CSS.match(/--log-bg:/g)?.length).toBe(1);
    expect([...LOG.keys()]).toEqual(
      expect.arrayContaining(['log-bg', 'log-bar', 'log-fg', 'log-dim', 'log-faint', 'log-err'])
    );
  });

  test.each(['fg', 'dim', 'faint', 'err', 'warn', 'ok', 'cmd'])(
    'log-%s reads on the log background and on the toolbar',
    (name) => {
      expect(contrast(tok(`log-${name}`), tok('log-bg'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok(`log-${name}`), tok('log-bar'))).toBeGreaterThanOrEqual(4.5);
    }
  );

  test('error text reads on its own 13% wash, and the row hover', () => {
    const wash = blend(tok('log-err'), tok('log-bg'), 0.13);
    expect(contrast(tok('log-err'), wash)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tok('log-fg'), blend(tok('log-fg'), tok('log-bg'), 0.05))
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('a pressed chip reads', () => {
    expect(contrast(tok('log-on-fg'), tok('log-on'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('LogLine', () => {
  const levels: LogLevel[] = ['info', 'error', 'warn', 'ok', 'cmd', 'dim'];

  test('each level has its own colour, and only error gets the row wash', () => {
    for (const level of levels) {
      const host = render(createElement(LogLine, { level }, 'text'));
      const row = host.firstElementChild as HTMLElement;
      expect(row.className.includes('bg-log-err'), level).toBe(level === 'error');
      expect(
        host.querySelector(
          `span.text-log-${level === 'info' ? 'fg' : level === 'error' ? 'err' : level}`
        ),
        level
      ).not.toBeNull();
    }
  });

  test('error and warning also carry a word, so colour is not the only cue', () => {
    expect(render(createElement(LogLine, { level: 'error' }, 'boom')).textContent).toContain(
      'ERROR'
    );
    expect(render(createElement(LogLine, { level: 'warn' }, 'hmm')).textContent).toContain('WARN');
    expect(render(createElement(LogLine, { level: 'info' }, 'ok')).textContent).not.toContain(
      'INFO'
    );
  });

  test('the gutter, time, queue and job columns show only when given', () => {
    const bare = render(createElement(LogLine, {}, 'x'));
    expect(bare.querySelectorAll('span').length).toBe(1);
    const full = render(
      createElement(LogLine, { n: 7, time: '12:00:01', queue: 'emails', job: 'j-9' }, 'x')
    );
    expect(full.textContent).toBe('712:00:01emailsj-9x');
  });
});

describe('LogChip', () => {
  test('is a toggle: aria-pressed follows the prop, and a count is shown', () => {
    const off = render(
      createElement(LogChip, { pressed: false, count: 12 }, 'Error')
    ).querySelector('button');
    const on = render(createElement(LogChip, { pressed: true }, 'Error')).querySelector('button');
    expect(off?.getAttribute('aria-pressed')).toBe('false');
    expect(off?.textContent).toBe('Error12');
    expect(on?.getAttribute('aria-pressed')).toBe('true');
    expect(on?.classList.contains('bg-log-on')).toBe(true);
    expect(off?.classList.contains('bg-log-on')).toBe(false);
  });

  test('keeps the focus ring the shared rule requires', () => {
    const button = render(createElement(LogChip, { pressed: false }, 'Info')).querySelector(
      'button'
    );
    expect(button?.classList.contains('focus-visible:outline-2')).toBe(true);
    expect(button?.classList.contains('focus-visible:outline-ring')).toBe(true);
  });
});

describe('LogBox, LogSearch and MiniLog', () => {
  test('the box is dark by token, with no theme-dependent background', () => {
    const box = render(createElement(LogBox, {}, 'x')).firstElementChild;
    expect(box?.classList.contains('bg-log-bg')).toBe(true);
    expect(box?.classList.contains('bg-surface')).toBe(false);
  });

  test('the search field is a labelled search input whose wrapper owns the focus ring', () => {
    const host = render(
      createElement(LogSearch, { 'aria-label': 'Search logs', placeholder: 'Search' })
    );
    const input = host.querySelector('input');
    expect(input?.getAttribute('type')).toBe('search');
    expect(input?.getAttribute('aria-label')).toBe('Search logs');
    expect(host.querySelector('label')?.className).toContain('focus-within:outline-ring');
  });

  test('the mini log is a named log region with one row per line', () => {
    const host = render(
      createElement(MiniLog, {
        label: 'Last lines',
        lines: [{ text: 'a' }, { text: 'b', level: 'error' }],
      })
    );
    const region = host.querySelector('[role="log"]');
    expect(region?.getAttribute('aria-label')).toBe('Last lines');
    expect(region?.children.length).toBe(2);
  });
});
