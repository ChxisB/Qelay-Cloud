import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AreaChart } from '../src/components/ui/AreaChart';
import { StatCard, type StatTone } from '../src/components/ui/StatCard';
import {
  STATE_PILL,
  STATE_ROLE,
  STATE_SOLID,
  STATE_TEXT,
  type StateRole,
  StatusBadge,
  StatusDot,
  stateRole,
} from '../src/components/ui/StatusBadge';
import { ensureDom } from './domSetup';

const ROOT = join(import.meta.dir, '..');
const CSS = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
const ROLES: StateRole[] = ['waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed'];

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

describe('state role table', () => {
  test('every status string maps onto one of the six designed roles', () => {
    for (const [status, role] of Object.entries(STATE_ROLE)) {
      expect(ROLES, status).toContain(role);
    }
  });

  test('judgment calls from task 05 stay pinned', () => {
    expect(stateRole('paused')).toBe('waiting');
    expect(stateRole('waiting-children')).toBe('waiting');
    expect(stateRole('stalled')).toBe('delayed');
    expect(stateRole('retry')).toBe('delayed');
    expect(stateRole('compensating')).toBe('delayed');
    expect(stateRole('running')).toBe('active');
    expect(stateRole('compensation-stuck')).toBe('failed');
    expect(stateRole('compensated')).toBe('completed');
  });

  test('unknown and empty statuses fall back to waiting, case-insensitively', () => {
    expect(stateRole('???')).toBe('waiting');
    expect(stateRole('')).toBe('waiting');
    expect(stateRole('FAILED')).toBe('failed');
  });

  test('each role has a pill, a solid fill and a text class on its own tokens', () => {
    for (const role of ROLES) {
      expect(STATE_PILL[role]).toBe(`bg-state-${role}-bg text-state-${role}-fg`);
      expect(STATE_SOLID[role]).toBe(`bg-state-${role}-fg`);
      expect(STATE_TEXT[role]).toBe(`text-state-${role}-fg`);
      // The utilities exist only if the @theme inline mapping does.
      expect(CSS).toContain(`--color-state-${role}-bg: var(--state-${role}-bg)`);
      expect(CSS).toContain(`--color-state-${role}-fg: var(--state-${role}-fg)`);
    }
  });
});

describe('StatusBadge / StatusDot', () => {
  test('every mapped status renders its role pill, a dot and the status text', () => {
    for (const [status, role] of Object.entries(STATE_ROLE)) {
      const host = render(<StatusBadge status={status} />);
      const pill = host.firstElementChild as HTMLElement;
      expect(pill.className, status).toContain(`bg-state-${role}-bg`);
      expect(pill.className, status).toContain(`text-state-${role}-fg`);
      expect(pill.className).toContain('rounded-full');
      expect(pill.textContent).toBe(status);
      expect(pill.querySelector('.bg-current')).not.toBeNull();
    }
  });

  test('an empty status reads "unknown" on the waiting pill', () => {
    const pill = render(<StatusBadge status="" />).firstElementChild as HTMLElement;
    expect(pill.textContent).toBe('unknown');
    expect(pill.className).toContain('bg-state-waiting-bg');
  });

  test('StatusDot tones use semantic or state tokens, never a named hue', () => {
    const expected = {
      green: 'bg-success',
      amber: 'bg-warning',
      red: 'bg-danger-fill',
      zinc: 'bg-state-waiting-fg',
    } as const;
    for (const [tone, cls] of Object.entries(expected)) {
      const host = render(<StatusDot label="x" tone={tone as keyof typeof expected} />);
      expect(host.querySelector('span > span')?.className).toContain(cls);
    }
  });
});

describe('StatCard tones', () => {
  const tones: Array<[StatTone, string]> = [
    ['default', 'text-fg'],
    ['green', 'text-success'],
    ['red', 'text-danger'],
    ['amber', 'text-warning'],
    ['active', 'text-state-active-fg'],
    ['waiting', 'text-state-waiting-fg'],
  ];

  test.each(tones)('%s colours the value with %s', (tone, cls) => {
    const host = render(<StatCard label="L" value="7" tone={tone} />);
    const value = [...host.querySelectorAll('div')].find((el) => el.textContent === '7');
    expect(value?.className).toContain(cls);
  });
});

describe('AreaChart colours', () => {
  // Line paths only: the area fill is a separate, unstroked path.
  const stroke = (host: HTMLElement) =>
    [...host.querySelectorAll('path[fill="none"]')].map((p) => p.getAttribute('stroke'));

  test('series colours are passed through as CSS variables, so a theme switch repaints via the cascade', () => {
    const host = render(
      <AreaChart
        series={[{ label: 'a', color: 'var(--state-active-fg)', points: [1, 2, 3], area: true }]}
      />
    );
    expect(stroke(host)).toContain('var(--state-active-fg)');
    const stops = [...host.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
    expect(stops).toEqual(['var(--state-active-fg)', 'var(--state-active-fg)']);

    // Nothing in the markup is a resolved colour: flipping the theme changes no attribute.
    const before = host.innerHTML;
    document.documentElement.dataset.theme = 'light';
    expect(host.innerHTML).toBe(before);
    delete document.documentElement.dataset.theme;
  });

  test('a plain series draws no brand gradient', () => {
    const host = render(<AreaChart series={[{ label: 'a', color: 'var(--x)', points: [1, 2] }]} />);
    expect(
      host.querySelector('[gradientUnits="userSpaceOnUse"], [gradientunits="userSpaceOnUse"]')
    ).toBeNull();
    expect(host.innerHTML).not.toContain('--brand-');
  });

  test('a gradient series strokes orange → pink → violet across the plot width, with a violet fade', () => {
    const host = render(
      <AreaChart
        series={[
          { label: 'push', color: 'var(--x)', points: [1, 3, 2], area: true, gradient: true },
          { label: 'pull', color: 'var(--state-waiting-fg)', points: [1, 1, 1] },
        ]}
      />
    );
    const gradients = [...host.querySelectorAll('linearGradient')];
    const strokeGradient = gradients.find(
      (g) => g.getAttribute('gradientUnits') === 'userSpaceOnUse'
    );
    expect(strokeGradient).toBeDefined();
    expect(strokeGradient?.getAttribute('x1')).toBe('0');
    expect(strokeGradient?.getAttribute('x2')).toBe('600');
    expect(
      [...(strokeGradient?.querySelectorAll('stop') ?? [])].map((s) => s.getAttribute('stop-color'))
    ).toEqual(['var(--brand-1)', 'var(--brand-2)', 'var(--brand-3)']);
    // Exactly one gradient stroke, and it is the first series; the other stays solid.
    expect(
      gradients.filter((g) => g.getAttribute('gradientUnits') === 'userSpaceOnUse')
    ).toHaveLength(1);
    const strokes = stroke(host);
    expect(strokes[0]).toBe(`url(#${strokeGradient?.id})`);
    expect(strokes[1]).toBe('var(--state-waiting-fg)');
    // The area fade under the gradient line is the violet stop at 22%.
    const fade = host.querySelector('linearGradient[id$="-g0"] stop');
    expect(fade?.getAttribute('stop-color')).toBe('var(--brand-3)');
    expect(fade?.getAttribute('stop-opacity')).toBe('0.22');
  });

  test('brand gradient stops are theme-independent tokens declared once', () => {
    for (const [name, hex] of [
      ['brand-1', '#ff7a00'],
      ['brand-2', '#ff3d61'],
      ['brand-3', '#7a3dff'],
    ]) {
      expect(CSS.match(new RegExp(`--${name}: ${hex};`, 'g'))).toHaveLength(1);
    }
  });
});

// Hue names assembled from parts: Tailwind scans test/ too, and literal class names here
// would emit dead utilities.
const HUES = [
  'blue',
  'zinc',
  'violet',
  'orange',
  'cyan',
  'red',
  'emerald',
  'amber',
  'pink',
  'fuchsia',
  'rose',
  'sky',
];
const PREFIXES = [
  'text',
  'bg',
  'border',
  'ring',
  'outline',
  'from',
  'to',
  'via',
  'fill',
  'stroke',
  'divide',
];
const NAMED_SCALE = new RegExp(`\\b(?:${PREFIXES.join('|')})-(?:${HUES.join('|')})-\\d+`);
const RAW_HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function offenders(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, i) =>
        pattern.test(text) && !text.trimStart().startsWith('*')
          ? [`${relative(ROOT, file)}:${i + 1}`]
          : []
      )
  );
}

describe('colour guards', () => {
  const src = sourceFiles(join(ROOT, 'src'));
  const demo = join(ROOT, 'src/lib/demo');

  test('no named Tailwind colour scale anywhere in src', () => {
    expect(offenders(src, NAMED_SCALE)).toEqual([]);
  });

  test('no raw hex in the badge, stat, chart and benchmark components', () => {
    const files = [
      'src/components/ui/StatusBadge.tsx',
      'src/components/ui/StatCard.tsx',
      'src/components/ui/AreaChart.tsx',
      'src/pages/control/metrics/ThroughputCharts.tsx',
      'src/pages/control/benchmark/BenchmarkResults.tsx',
    ].map((f) => join(ROOT, f));
    expect(offenders(files, RAW_HEX)).toEqual([]);
  });

  test('no raw hex in components, pages or features except the brand mark', () => {
    const files = src.filter(
      (f) =>
        /src\/(components|pages|features)\//.test(f) &&
        !f.startsWith(demo) &&
        !f.includes('components/brand/')
    );
    expect(offenders(files, RAW_HEX)).toEqual([]);
  });

  test('at most one colour gradient is declared per page component', () => {
    const gradients = /bg-gradient-|<linearGradient|gradient: true|\bgradient\b(?=\s*[,}])/;
    const pages = src.filter((f) => /src\/pages\//.test(f));
    const hits = offenders(pages, gradients);
    const perFile = new Map<string, number>();
    for (const hit of hits) {
      const file = hit.split(':')[0];
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    for (const [file, count] of perFile) expect(count, file).toBeLessThanOrEqual(1);
  });
});
