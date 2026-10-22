import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JobFlow } from '../src/pages/control/overview/JobFlow';
import { EMPTY_OVERVIEW, type OverviewSnapshot } from '../src/pages/control/overview/model';
import { ensureDom } from './domSetup';

// The Home "Job flow": the lifecycle as five figures joined by lines. happy-dom has no layout and plays no animation,
// so these check what is drawn, what the screen reader is told, and above all what must NOT restart on a poll.

const snap = (patch: Partial<OverviewSnapshot> = {}, stats = {}): OverviewSnapshot => ({
  ...EMPTY_OVERVIEW,
  overview: {
    ...EMPTY_OVERVIEW.overview,
    stats: {
      ...EMPTY_OVERVIEW.overview.stats,
      completed: 11,
      active: 2,
      totalPushed: 50,
      ...stats,
    },
    throughput: { ...EMPTY_OVERVIEW.overview.throughput, pushPerSec: 1.5, pullPerSec: 0.5 },
  },
  readyTotal: 6,
  waitingTotal: 5,
  prioritizedTotal: 1,
  delayedTotal: 3,
  ...patch,
});

const realMatchMedia = window.matchMedia;
function viewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') && wide,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const mounted: Array<() => void> = [];
function mount(s: OverviewSnapshot) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(JobFlow, { snapshot: s })));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    again: (next: OverviewSnapshot) =>
      act(() => root.render(createElement(JobFlow, { snapshot: next }))),
  };
}

beforeEach(() => {
  ensureDom();
  viewport(true);
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  for (const unmount of mounted.splice(0)) unmount();
});

const count = (host: HTMLElement, selector: string) => host.querySelectorAll(selector).length;

describe('JobFlow', () => {
  test('draws the five figures, with the same hints and numbers the tiles had', () => {
    const { host } = mount(snap());
    const text = host.textContent ?? '';
    for (const word of ['Job flow', 'Ready backlog', 'Active', 'Completed', 'Delayed']) {
      expect(text).toContain(word);
    }
    expect(text).toContain('5 waiting · 1 prioritized');
    expect(text).toContain('in flight now');
    expect(text).toContain('50 pushed since restart');
    expect(text).toContain('scheduled for later');
    expect(text).toContain('1.50 / s');
    expect(text).toContain('0.50 / s');
    expect(text).not.toContain('Failed');
    expect(count(host, '[data-wire]')).toBe(4);
  });

  test('Failed joins, with its own line, only while failures are recorded', () => {
    const { host, again } = mount(snap());
    again(snap({ failedTotal: 4 }));
    expect(host.textContent).toContain('Failed');
    expect(host.textContent).toContain('recorded across queues');
    expect(count(host, '[data-wire]')).toBe(5);
    expect(count(host, '.motion-draw-y')).toBe(2);
    again(snap({ failedTotal: 0 }));
    expect(host.textContent).not.toContain('recorded across queues');
    expect(count(host, '[data-wire]')).toBe(4);
  });

  test('a screen reader gets one sentence, and the lines carry no text of their own', () => {
    const { host } = mount(snap({ failedTotal: 4 }));
    const sentence = host.querySelector('p.sr-only')?.textContent;
    expect(sentence).toBe(
      'Push 1.50 jobs per second into the ready backlog of 6. ' +
        'Workers pull 0.50 jobs per second: 2 active now, 11 completed. 3 delayed for later. ' +
        '4 failed, recorded across queues.'
    );
    expect(host.querySelector('[data-wire]')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('a backlog over the threshold turns amber, and the glyph keeps the word company', () => {
    const { host } = mount(snap({ readyTotal: 250 }));
    const figure = [...host.querySelectorAll('div')].find((d) => d.textContent === '250');
    expect(figure?.className).toContain('text-warning');
    expect(count(host, 'svg[aria-hidden="true"]')).toBe(3);
  });

  test('a poll washes only the figure that changed and sends a comet only down the line it fed', () => {
    const { host, again } = mount(snap());
    expect(count(host, '.motion-flash')).toBe(0);
    expect(count(host, '.motion-comet, .motion-comet-y')).toBe(0);

    again(snap()); // the same numbers again: nothing moves
    expect(count(host, '.motion-flash')).toBe(0);
    expect(count(host, '.motion-comet, .motion-comet-y')).toBe(0);

    again(snap({}, { completed: 12 }));
    expect(count(host, '.motion-flash')).toBe(1);
    expect(host.querySelector('.motion-flash')?.textContent).toBe('12');
    expect(count(host, '.motion-comet')).toBe(1);

    // A fall in a figure flashes too, but no job arrived anywhere: no second comet. (The first wash stays marked; it
    // has played and only a new key restarts it.)
    again(snap({ readyTotal: 5 }, { completed: 12 }));
    expect([...host.querySelectorAll('.motion-flash')].map((n) => n.textContent)).toEqual([
      '5',
      '12',
    ]);
    expect(count(host, '.motion-comet')).toBe(1);
  });

  test('the nodes arrive in a stagger, the lines draw after them', () => {
    const { host } = mount(snap({ failedTotal: 1 }));
    const arriving = [...host.querySelectorAll<HTMLElement>('.motion-arrive')];
    expect(arriving.map((n) => Number(n.style.getPropertyValue('--i'))).sort()).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const drawn = [...host.querySelectorAll<HTMLElement>('[data-wire]')].map((n) =>
      Number(n.style.getPropertyValue('--i'))
    );
    expect(Math.min(...drawn)).toBeGreaterThan(4);
  });

  test('narrow: one column, the lines run down and Delayed and Failed sit below as side branches', () => {
    viewport(false);
    const { host } = mount(snap({ failedTotal: 2 }));
    expect(count(host, '[style*="grid-template-columns"]')).toBe(0);
    expect(count(host, '[data-wire]')).toBe(3);
    expect(count(host, '.motion-draw')).toBe(0);
    expect(count(host, '.motion-draw-y')).toBe(3);
    expect(host.textContent).toContain('Delayed');
    expect(host.textContent).toContain('Failed');
  });
});
