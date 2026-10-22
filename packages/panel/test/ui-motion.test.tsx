import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AreaChart } from '../src/components/ui/AreaChart';
import { Banner } from '../src/components/ui/Banner';
import { HBars, Meter } from '../src/components/ui/charts/HBars';
import { CopyButton } from '../src/components/ui/CopyButton';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '../src/components/ui/feedback';
import { StatCard } from '../src/components/ui/StatCard';
import { StatusBadge } from '../src/components/ui/StatusBadge';
import { ensureDom, settle } from './domSetup';

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

describe('states that arrive', () => {
  test('an empty state, an error, the offline strip and a banner rise in', () => {
    const roots = [
      mount(createElement(EmptyState, { title: 'No jobs' })).host,
      mount(createElement(ErrorState, { error: new Error('x') })).host,
      mount(createElement(OfflineBanner, {})).host,
      mount(createElement(Banner, { title: 'Heads up' })).host,
    ].map((host) => host.firstElementChild?.className ?? '');
    for (const className of roots) expect(className).toContain('motion-arrive');
  });

  test('the loading skeleton pulses only where motion is allowed, and is the one thing that loops', () => {
    const { host } = mount(createElement(LoadingState, {}));
    const bars = [...host.querySelectorAll('span')].filter((el) => el.className.includes('pulse'));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.className).toContain('motion-safe:animate-pulse');
  });

  test('"Copied" is announced and goes back by itself, on the icon button and on Copy details', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    const icon = mount(createElement(CopyButton, { value: 'job-1' })).host;
    const details = mount(createElement(ErrorState, { error: new Error('x') })).host;
    const press = (button: Element | undefined) =>
      act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const copyDetails = () =>
      [...details.querySelectorAll('button')].find((b) => /Cop/.test(b.textContent ?? ''));

    press(first(icon, 'button'));
    press(copyDetails());
    await settle(1);
    expect(first(icon, '[role="status"]').textContent).toBe('Copied to clipboard');
    expect(copyDetails()?.textContent).toBe('Copied');

    await settle(1600);
    expect(first(icon, 'button').getAttribute('aria-label')).toBe('Copy to clipboard');
    expect(first(icon, '[role="status"]').textContent).toBe('');
    expect(copyDetails()?.textContent).toBe('Copy details');
  });
});

describe('a figure that changed', () => {
  const card = (value: ReactElement | number | string) =>
    createElement(StatCard, { label: 'Active', value });
  const figure = (host: Element) => first<HTMLElement>(host, '.tnum');

  test('washes once when the number really changes, and on nothing else', () => {
    const { host, again } = mount(card(5));
    const before = figure(host);
    expect(before.className).not.toContain('motion-flash');

    again(card(5));
    expect(figure(host)).toBe(before);
    expect(figure(host).className).not.toContain('motion-flash');

    again(card(6));
    expect(figure(host)).not.toBe(before);
    expect(figure(host).className).toContain('motion-flash');
    expect(figure(host).textContent).toBe('6');

    const washed = figure(host);
    again(card(6));
    expect(figure(host)).toBe(washed);
  });

  test('an element value is new on every render, so it never washes', () => {
    const { host, again } = mount(card(createElement('b', null, '5')));
    const before = figure(host);
    again(card(createElement('b', null, '5')));
    expect(figure(host)).toBe(before);
    expect(figure(host).className).not.toContain('motion-flash');
  });
});

describe('a meter', () => {
  const meter = (value: number) => createElement(Meter, { value, max: 10, label: 'Disk' });
  const fill = (host: Element) => first<HTMLElement>(host, '[role="meter"] > span');

  test('draws in once, then moves the same bar to each new value', () => {
    const { host, again } = mount(meter(3));
    const bar = fill(host);
    expect(bar.className).toContain('motion-fill');
    expect(bar.style.transform).toBe('scaleX(0.3)');

    again(meter(3));
    expect(fill(host)).toBe(bar);

    again(meter(8));
    expect(fill(host)).toBe(bar);
    expect(bar.style.transform).toBe('scaleX(0.8)');
  });

  test('every bar of a bar chart is the same kind of fill', () => {
    const { host } = mount(
      createElement(HBars, {
        label: 'Queues',
        rows: [
          { label: 'a', value: 1 },
          { label: 'b', value: 2 },
        ],
      })
    );
    const classes = [...host.querySelectorAll('[class*="rounded-full"] > span')].map(
      (el) => el.className
    );
    expect(classes).toHaveLength(2);
    for (const className of classes) expect(className).toContain('motion-fill');
  });
});

describe('a chart', () => {
  const chart = (points: number[]) =>
    createElement(AreaChart, { series: [{ label: 'Done', color: 'red', points, area: true }] });
  const lineGroup = (host: Element) => first<SVGGElement>(host, 'svg g > g');
  const outerGroup = (host: Element) => first<SVGGElement>(host, 'svg g.motion-draw');

  test('draws its line in once, when the series first has points', () => {
    const { host, again } = mount(chart([]));
    expect(outerGroup(host)).toBeNull();
    again(chart([1, 2, 3]));
    expect(outerGroup(host)).not.toBeNull();
    const drawn = outerGroup(host);
    again(chart([1, 2, 4]));
    expect(outerGroup(host)).toBe(drawn);
  });

  test('an unchanged poll leaves the chart alone', () => {
    const { host, again } = mount(chart([1, 2, 3]));
    const before = lineGroup(host);
    again(chart([1, 2, 3]));
    expect(lineGroup(host)).toBe(before);
    expect(before.getAttribute('class')).toBeNull();
  });

  test('slides one step when the window rolls by a point, and for no other change', () => {
    const { host, again } = mount(chart([1, 2, 3]));
    const before = lineGroup(host);

    again(chart([2, 3, 4]));
    const rolled = lineGroup(host);
    expect(rolled).not.toBe(before);
    expect(rolled.getAttribute('class')).toBe('motion-step');
    // A step is one point's width in the chart's own units: 600 across two gaps.
    expect(rolled.getAttribute('style')).toContain('--step: 300px');

    again(chart([2, 3, 4]));
    expect(lineGroup(host)).toBe(rolled);

    // A corrected value, and a window that grew, are not a roll.
    again(chart([2, 9, 4]));
    expect(lineGroup(host)).toBe(rolled);
    again(chart([2, 9, 4, 5]));
    expect(lineGroup(host)).toBe(rolled);
  });

  test('a flat line that rolls to the same values is an unchanged poll', () => {
    const { host, again } = mount(chart([0, 0, 0]));
    const before = lineGroup(host);
    again(chart([0, 0, 0]));
    expect(lineGroup(host)).toBe(before);
  });
});

describe('a status that changed', () => {
  const badge = (status: string) => createElement(StatusBadge, { status });
  const pill = (host: Element) => first<HTMLElement>(host, 'span');

  test('sends a ring out once when the state changes, never on a repeat or the first draw', () => {
    const { host, again } = mount(badge('active'));
    const before = pill(host);
    expect(before.className).not.toContain('motion-ping');

    again(badge('active'));
    expect(pill(host)).toBe(before);

    // Another word for the same state is not a change of state.
    again(badge('running'));
    expect(pill(host)).toBe(before);
    expect(pill(host).className).not.toContain('motion-ping');

    again(badge('failed'));
    expect(pill(host)).not.toBe(before);
    expect(pill(host).className).toContain('motion-ping');
    expect(pill(host).textContent).toBe('failed');
  });
});
