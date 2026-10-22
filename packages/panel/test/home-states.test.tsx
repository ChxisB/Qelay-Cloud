import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { AttentionList } from '../src/pages/control/home/AttentionList';
import { HomeCards } from '../src/pages/control/home/HomeCards';
import type { HomeIssue } from '../src/pages/control/home/model';
import type { QueueHealth } from '../src/pages/control/overview/model';
import { OverviewHeader } from '../src/pages/control/overview/OverviewHeader';
import { QueueHealthTable } from '../src/pages/control/overview/QueueHealthTable';
import { RecentActivity } from '../src/pages/control/overview/RecentActivity';
import { StatusStripView } from '../src/pages/control/overview/StatusStrip';
import { ensureDom, settle } from './domSetup';
import { deployment } from './ops.helpers';

// The rest of the Home board: a state is its word and a glyph, "Needs attention" is a polite live region that clears
// quietly, new activity rises in, and the queue table draws once. happy-dom plays no animation, so these check what is
// drawn and above all what must NOT restart on a poll.

const mounted: Array<() => void> = [];
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const wrap = (el: ReactElement) => createElement(MemoryRouter, {}, el);
  act(() => root.render(wrap(element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, again: (next: ReactElement) => act(() => root.render(wrap(next))) };
}

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const count = (host: HTMLElement, selector: string) => host.querySelectorAll(selector).length;
const glyphs = (host: HTMLElement) => count(host, 'svg[aria-hidden="true"]');

describe('glyphs beside the state words', () => {
  const header = (degraded: boolean) =>
    createElement(OverviewHeader, {
      live: !degraded,
      paused: false,
      degraded,
      updatedAt: 0,
      onTogglePause: () => {},
      strip: { host: 'h', version: null, uptime: '1m', ram: '1 MB' },
    });

  test('the connection word has a glyph, not a dot', () => {
    const ok = mount(header(false)).host;
    expect(ok.textContent).toContain('Server connected');
    expect(glyphs(ok)).toBe(1);
    expect(count(ok, '.size-2.rounded-full')).toBe(0);
    const lost = mount(header(true)).host;
    expect(lost.textContent).toContain('Connection lost — showing last known data');
    expect(glyphs(lost)).toBe(1);
  });

  test('the delivery strip keeps its word and tone and gains a glyph', () => {
    const unknown = mount(
      createElement(StatusStripView, { data: null, error: new Error('x') })
    ).host;
    const strip = unknown.querySelector('[data-testid="status-strip"]');
    expect(strip?.getAttribute('data-tone')).toBe('zinc');
    expect(strip?.textContent).toContain('Unknown');
    expect(glyphs(unknown)).toBe(1);
    expect(count(unknown, '.size-2\\.5.rounded-full')).toBe(0);

    const healthy = mount(createElement(StatusStripView, { data: deployment(), error: null })).host;
    expect(healthy.querySelector('[data-testid="status-strip"]')?.getAttribute('data-tone')).toBe(
      'green'
    );
    expect(glyphs(healthy)).toBe(1);
  });

  test('a card hint gets a glyph only when its tone means something, and arrives in a stagger', () => {
    const { host } = mount(
      createElement(HomeCards, {
        cards: [
          { id: 'a', label: 'A', to: '/a', value: '1', hint: 'plain' },
          { id: 'b', label: 'B', to: '/b', value: '2', hint: '2 paused', tone: 'amber' },
          { id: 'c', label: 'C', to: '/c', value: '—', hint: 'Unavailable', tone: 'waiting' },
        ],
      })
    );
    expect(glyphs(host)).toBe(2);
    expect(host.querySelector('[data-testid="home-card-a"]')?.textContent).toBe('A1plain');
    expect(host.querySelector('[data-testid="home-card-b"]')?.textContent).toBe('B22 paused');
    const places = [...host.querySelectorAll<HTMLElement>('.motion-arrive')].map((n) =>
      n.style.getPropertyValue('--i')
    );
    expect(places).toEqual(['0', '1', '2']);
  });
});

describe('Needs attention', () => {
  const issue = (id: string): HomeIssue => ({
    id,
    rank: 0,
    headline: `Headline ${id}`,
    detail: 'detail',
    label: 'Open',
    to: '/x',
  });
  const list = (issues: HomeIssue[], unavailable: string[] = []) =>
    createElement(AttentionList, { issues, settled: true, unavailable });

  test('is a polite live region, and an issue rises in', () => {
    const { host } = mount(list([issue('a'), issue('b')]));
    expect(host.querySelector('section')?.getAttribute('aria-live')).toBe('polite');
    expect(count(host, 'li.motion-arrive')).toBe(2);
  });

  test('a cleared issue fades out in its place, cannot be tabbed to, then goes', async () => {
    const { host, again } = mount(list([issue('a'), issue('b')]));
    again(list([issue('b')]));
    const gone = [...host.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Headline a')
    );
    expect(gone?.classList.contains('motion-leave')).toBe(true);
    expect(gone?.hasAttribute('inert')).toBe(true);
    expect(count(host, 'li.motion-arrive')).toBe(1);
    await settle(60);
    await settle(260);
    expect(host.textContent).not.toContain('Headline a');
    expect(host.textContent).toContain('Headline b');
  });

  test('a poll with the same issues restarts nothing', () => {
    const { host, again } = mount(list([issue('a')]));
    const before = host.querySelector('li');
    again(list([issue('a')]));
    expect(host.querySelector('li')).toBe(before);
    expect(count(host, 'li.motion-leave')).toBe(0);
  });

  test('"Nothing needs attention" has a glyph, and a missing reading is not a clean bill', () => {
    const clean = mount(list([])).host;
    expect(clean.textContent).toContain('Nothing needs attention.');
    expect(glyphs(clean)).toBe(1);
    const partial = mount(list([], ['Health'])).host;
    expect(partial.textContent).toContain('Nothing needs attention in what could be read.');
    expect(partial.textContent).toContain('Could not be read: Health.');
    expect(glyphs(partial)).toBe(1);
  });
});

describe('queue health table', () => {
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
    counts: counts({ waiting: 4 }),
    ...over,
  });
  const table = (rows: QueueHealth[]) =>
    createElement(QueueHealthTable, { rows, total: rows.length });

  test('the rows of the first load arrive in a stagger, and a row a poll adds later does not', () => {
    const { host, again } = mount(table([queue('a'), queue('b')]));
    expect(count(host, 'tbody tr.motion-arrive')).toBe(2);
    again(table([queue('a'), queue('b')]));
    again(table([queue('a'), queue('b'), queue('c')]));
    expect(count(host, 'tbody tr')).toBe(3);
    expect(count(host, 'tbody tr.motion-arrive')).toBe(2);
  });

  test('the bars draw once: a segment carries the fill, and a poll creates no new node', () => {
    const { host, again } = mount(
      table([queue('a', { counts: counts({ waiting: 4, active: 1 }) })])
    );
    const bar = host.querySelector('[role="img"]');
    expect(count(host, '[role="img"] .motion-fill')).toBe(2);
    const segment = bar?.firstElementChild;
    again(table([queue('a', { counts: counts({ waiting: 6, active: 1 }) })]));
    expect(host.querySelector('[role="img"]')?.firstElementChild).toBe(segment);
  });

  test('a poll washes only the count that changed', () => {
    const { host, again } = mount(table([queue('a')]));
    expect(count(host, '.motion-flash')).toBe(0);
    again(table([queue('a')]));
    expect(count(host, '.motion-flash')).toBe(0);
    again(table([queue('a', { counts: counts({ waiting: 5 }) })]));
    expect([...host.querySelectorAll('.motion-flash')].map((n) => n.textContent)).toEqual(['5']);
  });
});

describe('recent activity', () => {
  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  let controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const frame = (event: string, jobId: string) =>
    encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify({ queue: 'q', jobId, timestamp: 1_700_000_000_000 })}\n\n`
    );

  beforeEach(() => {
    controllers = [];
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start: (c) => void controllers.push(c) }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )) as unknown as typeof fetch;
  });
  afterEach(() => {
    for (const c of controllers) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '' });
  });

  test('the events of the first read are the list; one that comes later rises in', async () => {
    const { host } = mount(createElement(RecentActivity));
    await settle(5);
    const push = (bytes: Uint8Array) => controllers.at(-1)?.enqueue(bytes);
    push(frame('job:active', 'a'));
    push(frame('job:completed', 'b'));
    await settle(200); // past the 150 ms flush timer
    expect(count(host, 'li')).toBe(2);
    expect(count(host, 'li.motion-arrive')).toBe(0);

    push(frame('job:active', 'c'));
    await settle(200);
    expect(count(host, 'li')).toBe(3);
    expect(count(host, 'li.motion-arrive')).toBe(1);
    expect(host.querySelector('li')?.classList.contains('motion-arrive')).toBe(true);
  });
});
