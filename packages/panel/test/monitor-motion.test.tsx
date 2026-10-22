import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { QueueSummaryFull } from '../src/lib/bqTypes';
import type { ActivityEvent } from '../src/lib/types';
import { useFreshAfter } from '../src/lib/useFreshAfter';
import { LogsEventList } from '../src/pages/control/logs/LogsEventList';
import { MetricsStatusPanels } from '../src/pages/control/metrics/MetricsStatusPanels';
import { OperationLatency, PerQueueMetrics } from '../src/pages/control/metrics/MetricsTables';
import { ensureDom, renderHook } from './domSetup';

// Monitor: Metrics and Logs. A poll that changes nothing animates nothing; a count that moves washes once; new log
// lines slide in, newest first, and only the newest few. happy-dom plays no animation, so these check which elements
// carry the motion classes and whether an element is the same one after the update.

const mounted: Array<() => void> = [];
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (next: ReactElement) =>
    act(() => root.render(createElement(MemoryRouter, null, next)));
  show(element);
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, show };
}
beforeEach(ensureDom);
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const placeOf = (el: Element) => (el as HTMLElement).style.getPropertyValue('--i');

describe('useFreshAfter', () => {
  test('a first list has nothing new; a head that moves up makes the lines above the old head new', () => {
    const hook = renderHook(useFreshAfter, 5 as number | undefined);
    expect(hook.result.current).toBe(5);
    hook.rerender(5);
    expect(hook.result.current).toBe(5);
    hook.rerender(9);
    expect(hook.result.current).toBe(5);
    hook.rerender(9);
    expect(hook.result.current).toBe(5);
    hook.rerender(12);
    expect(hook.result.current).toBe(9);
    hook.unmount();
  });

  test('a list that starts empty treats its first lines as new', () => {
    const hook = renderHook(useFreshAfter, undefined as number | undefined);
    expect(hook.result.current).toBe(Number.NEGATIVE_INFINITY);
    hook.rerender(1);
    expect(hook.result.current).toBe(Number.NEGATIVE_INFINITY);
    hook.unmount();
  });
});

describe('log lines', () => {
  const event = (seq: number): ActivityEvent => ({
    seq,
    event: `event-${seq}`,
    queue: 'emails',
    jobId: `job-${seq}`,
    status: 'completed',
    timestamp: Date.UTC(2026, 9, 20, 8, 30, 5),
  });
  // Newest first, as the stream holds them.
  const newest = (head: number, count: number) =>
    Array.from({ length: count }, (_, i) => event(head - i));
  const props = (rows: ActivityEvent[], over: { freshAfter?: number; term?: string } = {}) =>
    createElement(LogsEventList, {
      rows,
      term: over.term ?? '',
      selectedSeq: null,
      onSelect: () => {},
      empty: 'Nothing here.',
      total: rows.length,
      bufferSize: 250,
      ...(over.freshAfter === undefined ? {} : { freshAfter: over.freshAfter }),
    });
  const lines = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[role="button"]')];
  const arriving = (host: ParentNode) =>
    lines(host).filter((line) => line.classList.contains('motion-arrive'));

  test('with no freshAfter nothing slides in', () => {
    const { host } = mount(props(newest(10, 5)));
    expect(arriving(host)).toHaveLength(0);
  });

  test('lines above freshAfter slide in newest first and in order; the older ones stay still', () => {
    const { host } = mount(props(newest(10, 5), { freshAfter: 8 }));
    expect(
      arriving(host).map((line) => [line.textContent?.includes('event-10'), placeOf(line)])
    ).toEqual([
      [true, '0'],
      [false, '1'],
    ]);
    expect(lines(host)).toHaveLength(5);
  });

  test('only the newest eight of a burst slide in', () => {
    const { host } = mount(props(newest(100, 40), { freshAfter: 0 }));
    expect(arriving(host).map(placeOf)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  test('a line keeps its element and its slide when the next update lands, and the new line slides in', () => {
    const { host, show } = mount(props(newest(10, 5), { freshAfter: 9 }));
    const first = lines(host)[0]!;
    expect(first.classList.contains('motion-arrive')).toBe(true);

    show(props(newest(11, 6), { freshAfter: 10 }));
    expect(lines(host)).toHaveLength(6);
    expect(lines(host)[1]).toBe(first);
    expect(first.classList.contains('motion-arrive')).toBe(true);
    expect(placeOf(first)).toBe('0');
    expect(placeOf(lines(host)[0]!)).toBe('0');
    expect(arriving(host)).toHaveLength(2);
  });

  test('a search over lines that were already there makes none of them slide in', () => {
    const { host, show } = mount(props(newest(10, 5), { freshAfter: 10 }));
    expect(arriving(host)).toHaveLength(0);
    show(props(newest(10, 5).slice(1, 3), { freshAfter: 10, term: 'job-9' }));
    expect(arriving(host)).toHaveLength(0);
  });
});

describe('metrics figures', () => {
  const stats = (over: Partial<Record<string, number>> = {}) =>
    ({
      waiting: 4,
      active: 2,
      delayed: 0,
      dlq: 0,
      totalPushed: 1200,
      totalPulled: 1100,
      uptime: 3_600_000,
      completed: 900,
      ...over,
    }) as unknown as NonNullable<Parameters<typeof MetricsStatusPanels>[0]['stats']>;
  const panels = (rate: number | null, s: ReturnType<typeof stats>) =>
    createElement(MetricsStatusPanels, { rate, stats: s });

  test('a poll that changes nothing washes nothing; a moved count and a moved rate (error and success) wash once', () => {
    const { host, show } = mount(panels(0.01, stats()));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);
    show(panels(0.01, stats()));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    show(panels(0.02, stats({ waiting: 7 })));
    expect([...host.querySelectorAll('.motion-flash')].map((el) => el.textContent).sort()).toEqual([
      '2.00%',
      '7',
      '98.00%',
    ]);
  });

  test('uptime changes on every poll and never washes', () => {
    const { host, show } = mount(panels(0.01, stats()));
    const uptime = () =>
      [...host.querySelectorAll('dt')].find((dt) => dt.textContent?.includes('Uptime'))
        ?.nextElementSibling;
    const before = uptime()?.textContent;
    show(panels(0.01, stats({ uptime: 7_200_000 })));
    expect(uptime()?.textContent).not.toBe(before);
    expect(uptime()?.querySelector('.motion-flash')).toBeNull();
  });

  const queue = (name: string, failed: number): QueueSummaryFull => ({
    name,
    paused: false,
    counts: { waiting: 1, prioritized: 0, active: 2, completed: 30, failed, delayed: 0 },
  });
  const table = (rows: QueueSummaryFull[]) =>
    createElement(PerQueueMetrics, {
      rows,
      total: rows.length,
      page: 0,
      pageSize: 15,
      onPage: () => {},
      empty: 'No queues yet.',
    });

  test('the per-queue counts wash on a real change only, and failed keeps its bold', () => {
    const { host, show } = mount(table([queue('a', 0), queue('b', 3)]));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);
    show(table([queue('a', 0), queue('b', 3)]));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    show(table([queue('a', 0), queue('b', 4)]));
    const washed = [...host.querySelectorAll('.motion-flash')];
    expect(washed.map((el) => el.textContent)).toEqual(['4']);
    expect(washed[0]?.closest('td')?.classList.contains('font-bold')).toBe(true);
  });

  test('a slow p99 says so in a word and a glyph; a fast one says neither', () => {
    const latency = {
      percentiles: {
        push: { p50: 2, p95: 5, p99: 8 },
        pull: { p50: 10, p95: 60, p99: 180 },
        ack: { p50: 1, p95: 2, p99: 3 },
      },
      averages: { pushMs: 3, pullMs: 20, ackMs: 1 },
    } as unknown as Parameters<typeof OperationLatency>[0]['latency'];
    const { host } = mount(createElement(OperationLatency, { latency }));
    const p99 = [...host.querySelectorAll('tbody tr')].map((row) => row.lastElementChild);
    expect(p99.map((cell) => cell?.textContent)).toEqual(['8.0ms', 'slow 180ms', '3.0ms']);
    expect(p99.map((cell) => cell?.querySelector('svg[aria-hidden="true"]') !== null)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
