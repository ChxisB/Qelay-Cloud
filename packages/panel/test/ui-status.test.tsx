import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Spark, sparkPaths } from '../src/components/ui/Spark';
import { StatCard } from '../src/components/ui/StatCard';
import { STATE_ROLE, StatusBadge } from '../src/components/ui/StatusBadge';
import { Tag } from '../src/components/ui/Tag';
import { ensureDom } from './domSetup';

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

describe('status glyph', () => {
  test('each state role draws its own shape beside the word', () => {
    const shapes = new Map<string, string>();
    for (const [status, role] of Object.entries(STATE_ROLE)) {
      const pill = render(createElement(StatusBadge, { status })).firstElementChild as HTMLElement;
      const svg = pill.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden'), status).toBe('true');
      expect(pill.textContent).toBe(status);
      // Same role, same shape; different roles never share one.
      const d = [...(svg?.querySelectorAll('path') ?? [])]
        .map((p) => p.getAttribute('d'))
        .join('|');
      expect(d.length, status).toBeGreaterThan(0);
      expect(shapes.get(role) ?? d).toBe(d);
      shapes.set(role, d);
    }
    expect(new Set(shapes.values()).size).toBe(shapes.size);
  });

  test('completed and failed are filled, waiting is only outlined', () => {
    const fill = (status: string) =>
      render(createElement(StatusBadge, { status })).querySelector('circle')?.getAttribute('fill');
    expect(fill('completed')).toBe('currentColor');
    expect(fill('failed')).toBe('currentColor');
    expect(fill('waiting')).toBe('none');
  });
});

describe('Tag', () => {
  test('is an outlined label whose text stays readable on every tone', () => {
    const tag = render(createElement(Tag, { tone: 'gcp' }, 'GCP')).firstElementChild as HTMLElement;
    expect(tag.textContent).toBe('GCP');
    expect(tag.className).toContain('border');
    expect(tag.className).toContain('text-state-active-fg');
  });
});

describe('Spark', () => {
  test('maps the lowest value to the bottom of the line and the highest to the top', () => {
    const { line, area } = sparkPaths([1, 3, 2]);
    expect(line).toBe('M0.0 36.0 L50.0 6.0 L100.0 21.0');
    expect(area).toBe(`${line} L100 40 L0 40 Z`);
  });

  test('a flat series stays on one level instead of dividing by zero', () => {
    expect(sparkPaths([5, 5, 5]).line).toBe('M0.0 36.0 L50.0 36.0 L100.0 36.0');
  });

  test('draws nothing for fewer than two points', () => {
    expect(render(createElement(Spark, { values: [4] })).querySelector('svg')).toBeNull();
  });

  test('StatCard shows one decorative svg only when given a series', () => {
    const without = render(createElement(StatCard, { label: 'Waiting', value: 12 }));
    expect(without.querySelector('svg')).toBeNull();
    const withSpark = render(
      createElement(StatCard, { label: 'Waiting', value: 12, spark: [1, 2, 3] })
    );
    const svgs = withSpark.querySelectorAll('svg');
    expect(svgs.length).toBe(1);
    expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(withSpark.textContent).toBe('Waiting12');
  });
});
