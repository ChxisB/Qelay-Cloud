import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AreaChart } from '../src/components/ui/AreaChart';
import { Donut } from '../src/components/ui/charts/Donut';
import { Gantt } from '../src/components/ui/charts/Gantt';
import { HBars, Meter } from '../src/components/ui/charts/HBars';
import { HeatGrid } from '../src/components/ui/charts/HeatGrid';
import { StackedBars } from '../src/components/ui/charts/StackedBars';
import { ensureDom } from './domSetup';

const mounted: Array<() => void> = [];

function render(element: ReactElement): HTMLElement {
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

const nameOf = (host: HTMLElement) =>
  host.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('every chart is one image with a sentence for a name', () => {
  test('StackedBars names each series and its total', () => {
    const host = render(
      createElement(StackedBars, {
        label: 'Jobs per hour',
        series: [
          { tone: 'ok', name: 'Completed' },
          { tone: 'bad', name: 'Failed' },
        ],
        columns: [
          { label: '09', values: { ok: 40, bad: 2 } },
          { label: '10', values: { ok: 60, bad: 5 } },
        ],
      })
    );
    expect(nameOf(host)).toBe('Jobs per hour: Completed 100, Failed 7');
  });

  test('HBars lists every row with its value', () => {
    const host = render(
      createElement(HBars, {
        label: 'Slowest queues',
        rows: [
          { label: 'emails', value: 120, display: '120 ms' },
          { label: 'reports', value: 900 },
        ],
      })
    );
    expect(nameOf(host)).toBe('Slowest queues: emails 120 ms, reports 900');
  });

  test('HeatGrid gives each row a count, or the summary it was given', () => {
    const host = render(
      createElement(HeatGrid, {
        label: 'Activity',
        rows: [
          { label: 'emails', cells: [0, 1, 4, 'bad'] },
          { label: 'reports', cells: ['ok', 'ok'], summary: 'all healthy' },
        ],
      })
    );
    expect(nameOf(host)).toBe('Activity: emails 3 of 4, reports all healthy');
  });

  test('Donut gives each segment its value and share', () => {
    const host = render(
      createElement(Donut, {
        label: 'Outcomes',
        segments: [
          { label: 'Done', value: 75, tone: 'ok' },
          { label: 'Failed', value: 25, tone: 'bad' },
        ],
      })
    );
    expect(nameOf(host)).toBe('Outcomes: Done 75 (75%), Failed 25 (25%)');
  });

  test('Gantt gives each step its duration', () => {
    const host = render(
      createElement(Gantt, {
        label: 'Flow run',
        total: 10,
        rows: [
          { label: 'fetch', start: 0, end: 4, duration: '4 s' },
          { label: 'send', start: 4, end: 10, duration: '6 s', tone: 'bad' },
        ],
      })
    );
    expect(nameOf(host)).toBe('Flow run: fetch 4 s, send 6 s');
  });

  test('AreaChart still names itself and summarises the latest value', () => {
    const host = render(
      createElement(AreaChart, {
        ariaLabel: 'Throughput',
        series: [{ label: 'rate', color: 'var(--active)', points: [1, 2, 7] }],
      })
    );
    expect(nameOf(host)).toContain('Throughput');
  });
});

describe('colour is never the only cue', () => {
  test('a failed bar is hatched, and the legend and the name carry the word', () => {
    const host = render(
      createElement(StackedBars, {
        label: 'Jobs',
        series: [{ tone: 'bad', name: 'Failed' }],
        columns: [{ label: '09', values: { bad: 3 } }],
      })
    );
    expect(host.querySelector('.hatch-bad')).not.toBeNull();
    expect(nameOf(host)).toContain('Failed');
  });

  test('a bad heat cell is striped, not just red', () => {
    const host = render(
      createElement(HeatGrid, { label: 'A', rows: [{ label: 'q', cells: ['bad', 'ok'] }] })
    );
    const [bad, ok] = [...host.querySelectorAll('span.aspect-square')];
    expect(bad?.className).toContain('repeating-linear-gradient');
    expect(ok?.className).not.toContain('repeating-linear-gradient');
  });

  test('the donut legend spells out each share beside its swatch', () => {
    const host = render(
      createElement(Donut, {
        label: 'Outcomes',
        segments: [
          { label: 'Done', value: 3, tone: 'ok' },
          { label: 'Failed', value: 1, tone: 'bad' },
        ],
      })
    );
    expect(host.textContent).toContain('Done');
    expect(host.textContent).toContain('3 · 75%');
    expect(host.textContent).toContain('1 · 25%');
  });

  test('a second line series can be dashed', () => {
    const host = render(
      createElement(AreaChart, {
        series: [
          { label: 'a', color: 'var(--active)', points: [1, 2, 3] },
          { label: 'b', color: 'var(--bad)', points: [3, 2, 1], dashed: true },
        ],
      })
    );
    const dashes = [...host.querySelectorAll('path')].map((p) =>
      p.getAttribute('stroke-dasharray')
    );
    expect(dashes).toContain('7 5');
    expect(dashes.filter((d) => d === null).length).toBeGreaterThan(0);
  });
});

describe('Meter', () => {
  test('is a labelled meter on its own and decoration inside a chart', () => {
    const alone = render(createElement(Meter, { value: 30, max: 60, label: 'Disk used' }));
    const meter = alone.querySelector('[role="meter"]');
    expect(meter?.getAttribute('aria-valuenow')).toBe('30');
    expect(meter?.getAttribute('aria-valuemax')).toBe('60');
    const inside = render(createElement(HBars, { label: 'x', rows: [{ label: 'a', value: 1 }] }));
    expect(inside.querySelector('[role="meter"]')).toBeNull();
  });

  test('clamps a value outside its range', () => {
    // The fill is scaled, not resized: only a transform moves.
    const fill = (value: number) =>
      (render(createElement(Meter, { value, max: 10 })).querySelector('span') as HTMLElement).style
        .transform;
    expect(fill(50)).toBe('scaleX(1)');
    expect(fill(-5)).toBe('scaleX(0)');
    expect(fill(5)).toBe('scaleX(0.5)');
  });
});
