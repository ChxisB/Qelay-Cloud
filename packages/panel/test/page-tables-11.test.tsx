import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityEvent } from '../src/lib/types';
import { WarningList } from '../src/pages/control/deployment/WarningList';
import { levelOf, LogsEventList, markHits } from '../src/pages/control/logs/LogsEventList';
import { SelectedEvent } from '../src/pages/control/logs/SelectedEvent';
import { PerQueueMetrics } from '../src/pages/control/metrics/MetricsTables';
import { QueueDoorbellTable } from '../src/pages/control/transport/QueueDoorbellTable';
import { WorkersTable, type WorkerRow } from '../src/pages/control/workers/WorkersTable';
import { ensureDom } from './domSetup';
import { queue as bell } from './ops.helpers';

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

// Assembled from parts: Tailwind scans test/ too, and a literal would emit a dead utility.
const bar = (v: string) => ['[--rc:var(--', v, ')]'].join('');
const rowOf = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(text)) as HTMLElement;
const pill = (row: HTMLElement) => row.querySelector('span.rounded-full')?.textContent;

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('Workers table', () => {
  const worker = (id: string, status: string): WorkerRow => ({
    id,
    name: id,
    queues: ['q'],
    status,
    activeJobs: 0,
    processedJobs: 1,
    failedJobs: 0,
    lastSeen: Date.now(),
  });
  const props = {
    canOperate: false,
    onSort: () => {},
    busyIds: new Set<string>(),
    onRemove: () => {},
  };

  test('a stale worker has a word and a warn bar; an active one has the active word', () => {
    const host = render(
      createElement(WorkersTable, {
        ...props,
        rows: [worker('w-live', 'active'), worker('w-gone', 'stale')],
        sort: null,
      })
    );
    expect(pill(rowOf(host, 'w-live'))).toBe('active');
    expect(pill(rowOf(host, 'w-gone'))).toBe('stale');
    expect(rowOf(host, 'w-gone').classList.contains(bar('warn'))).toBe(true);
    expect(rowOf(host, 'w-live').classList.contains(bar('warn'))).toBe(false);
  });

  test('the sorted column says so, and numeric headers are right-aligned', () => {
    const host = render(
      createElement(WorkersTable, {
        ...props,
        rows: [worker('w', 'active')],
        sort: { key: 'failed', dir: 'desc' },
      })
    );
    const th = (name: string) =>
      [...host.querySelectorAll('thead th')].find((h) => h.textContent?.includes(name))!;
    expect(th('Failed').getAttribute('aria-sort')).toBe('descending');
    expect(th('Last seen').getAttribute('aria-sort')).toBeNull();
    expect(th('Processed').classList.contains('text-right')).toBe(true);
    expect(th('Processed').classList.contains('text-left')).toBe(false);
  });
});

describe('Logs viewer', () => {
  const event = (seq: number, status: ActivityEvent['status'], over = {}): ActivityEvent => ({
    seq,
    event: `event-${seq}`,
    queue: 'emails',
    jobId: `job-${seq}`,
    status,
    timestamp: Date.UTC(2026, 9, 20, 8, 30, 5),
    ...over,
  });
  const list = (rows: ActivityEvent[], over = {}) => ({
    rows,
    term: '',
    selectedSeq: null,
    onSelect: () => {},
    empty: 'Nothing here.',
    total: rows.length,
    bufferSize: 250,
    ...over,
  });

  test('levels: failed is an error, completed ok, waiting dim, anything else info', () => {
    expect(['failed', 'completed', 'waiting', 'active'].map(levelOf)).toEqual([
      'error',
      'ok',
      'dim',
      'info',
    ]);
  });

  test('markHits wraps every case-insensitive match and leaves a miss as plain text', () => {
    const host = render(createElement('p', {}, markHits('Emails-emails', 'mail')));
    expect([...host.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['mail', 'mail']);
    expect(host.textContent).toBe('Emails-emails');
    expect(markHits('orders', 'zzz')).toBe('orders');
    expect(markHits('orders', '')).toBe('orders');
  });

  test('markHits matches a mixed-case term, takes the term literally, and survives a length-changing letter', () => {
    const marked = (text: string, term: string) =>
      [...render(createElement('p', {}, markHits(text, term))).querySelectorAll('mark')].map(
        (m) => m.textContent
      );
    expect(marked('Emails-emails', 'Email')).toEqual(['Email', 'email']);
    expect(marked('a.b-axb', 'a.b')).toEqual(['a.b']);
    // 'İ'.toLowerCase() is two code units, so indexes taken from the lowered text drift off the original.
    expect(marked('İstanbul-job', 'job')).toEqual(['job']);
    expect(markHits('job', 'Z')).toBe('job');
  });

  test('a line is a button: click and Enter select it, and the selection is pressed', () => {
    const picked: number[] = [];
    const host = render(
      createElement(
        LogsEventList,
        list([event(1, 'completed'), event(2, 'failed', { error: 'boom' })], {
          selectedSeq: 2,
          onSelect: (seq: number) => picked.push(seq),
        })
      )
    );
    const lines = [...host.querySelectorAll('[role="log"] [role="button"]')] as HTMLElement[];
    expect(lines.map((l) => l.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    act(() => lines[0]!.click());
    act(() => {
      lines[1]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(picked).toEqual([1, 2]);
  });

  test('time is UTC with the ISO stamp as the title; a non-error line says its status in words', () => {
    const host = render(createElement(LogsEventList, list([event(1, 'completed')])));
    const line = host.querySelector('[role="button"]') as HTMLElement;
    expect(line.textContent).toContain('08:30:05');
    expect(line.getAttribute('title')).toBe('2026-10-20T08:30:05.000Z');
    expect(line.textContent?.toLowerCase()).toContain('completed');
  });

  test('an empty buffer shows the given words, and the foot counts what is shown', () => {
    const host = render(createElement(LogsEventList, list([], { total: 7 })));
    expect(host.textContent).toContain('Nothing here.');
    expect(host.textContent).toContain('Showing 0 of 7 events, newest first');
  });

  test('the selected event carries the way to its job and a copy control, and closes', () => {
    let closed = 0;
    const host = render(
      createElement(SelectedEvent, {
        event: event(1, 'failed', { jobId: 'job #1/a', error: 'boom' }),
        onClose: () => closed++,
      })
    );
    const open = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open job');
    expect(open?.getAttribute('href')).toBe('/job?id=job%20%231%2Fa');
    expect(host.querySelector('button[aria-label^="Copy"]')).not.toBeNull();
    expect(host.textContent).toContain('boom');
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Close')?.click());
    expect(closed).toBe(1);
  });

  test('an event with no job has no link and no copy control', () => {
    const host = render(
      createElement(SelectedEvent, {
        event: event(2, 'completed', { jobId: undefined }),
        onClose: () => {},
      })
    );
    expect([...host.querySelectorAll('a')].some((a) => a.textContent === 'Open job')).toBe(false);
    expect(host.querySelector('button[aria-label^="Copy"]')).toBeNull();
  });
});

describe('Metrics per-queue table', () => {
  const counts = { waiting: 1, prioritized: 0, active: 2, completed: 3, failed: 4, delayed: 0 };
  test('a paused queue is a word and an idle pill, a failing count is not muted', () => {
    const host = render(
      createElement(PerQueueMetrics, {
        rows: [
          { name: 'running', paused: false, counts },
          { name: 'held', paused: true, counts: { ...counts, failed: 0 } },
        ],
        total: 2,
        page: 0,
        pageSize: 10,
        onPage: () => {},
        empty: 'none',
      })
    );
    expect(pill(rowOf(host, 'running'))).toBe('active');
    expect(pill(rowOf(host, 'held'))).toBe('paused');
    expect(rowOf(host, 'running').querySelector('td:last-child')?.className).toContain('font-bold');
    expect(rowOf(host, 'held').querySelector('td:last-child')?.className).not.toContain(
      'font-bold'
    );
  });
});

describe('Transport doorbell rows', () => {
  const rows = [
    bell('alpha', { deadLetterDepth: 3 }),
    bell('bravo', {
      store: { claimable: 5, notRung: 5, oldestNotRungAgeMs: 120_000 },
    }),
    bell('charlie', { store: { paused: true } }),
    bell('delta'),
  ];

  test('every row names its verdict in a word', () => {
    const host = render(createElement(QueueDoorbellTable, { queues: rows, lateAfterMs: 60_000 }));
    expect(pill(rowOf(host, 'alpha'))).toBe('Delivery failed');
    expect(pill(rowOf(host, 'bravo'))).toBe('Maintenance behind');
    expect(pill(rowOf(host, 'charlie'))).toBe('Paused');
    expect(pill(rowOf(host, 'delta'))).toBe('Normal');
  });

  test('only a poison or tick-behind row has a bar', () => {
    const host = render(createElement(QueueDoorbellTable, { queues: rows, lateAfterMs: 60_000 }));
    expect(rowOf(host, 'alpha').classList.contains(bar('bad'))).toBe(true);
    expect(rowOf(host, 'bravo').classList.contains(bar('warn'))).toBe(true);
    for (const name of ['charlie', 'delta']) {
      expect(rowOf(host, name).classList.contains('[--rc:transparent]'), name).toBe(true);
    }
  });
});

describe('Deployment warnings', () => {
  const warning = (code: string, severity: 'critical' | 'warning') => ({
    code,
    severity,
    message: `${code} happened`,
  });

  test('severity is a pill word, and a critical one is announced as an alert', () => {
    const host = render(
      createElement(WarningList, {
        warnings: [warning('dev_token_enabled', 'warning'), warning('tick_stale', 'critical')],
      })
    );
    const items = [...host.querySelectorAll('[data-warning]')];
    expect(items.map((el) => el.getAttribute('data-warning'))).toEqual([
      'tick_stale',
      'dev_token_enabled',
    ]);
    expect(items.map((el) => el.getAttribute('role'))).toEqual(['alert', 'status']);
    expect(items.map((el) => pill(el as HTMLElement))).toEqual(['Critical', 'Warning']);
  });

  test('no warnings is a polite status that says so', () => {
    const host = render(createElement(WarningList, { warnings: [] }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('No warnings.');
  });
});
