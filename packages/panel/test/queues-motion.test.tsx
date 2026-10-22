import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { QueueLifecycle } from '../src/pages/control/queueDetail/QueueLifecycle';
import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';
import { QueuesTable } from '../src/pages/control/queues/QueuesTable';
import { QueuesOverview } from '../src/pages/control/QueuesOverview';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';
import { dlqConfig, queueDetail, queueSummaryEntry, stallConfig } from './queue-settings.helpers';

// The Queues board: asking in the page instead of the browser's dialog, the lifecycle diagram, rows that arrive once and
// counts that wash only when they really change. happy-dom plays no animation, so these check what is drawn and what must
// NOT restart on a poll.

const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;
const capabilitiesBefore = useCapabilitiesStore.getState();
const mounted: Array<() => void> = [];
let stopAnswering = () => {};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const count = (host: HTMLElement, selector: string) => host.querySelectorAll(selector).length;

function mount(element: ReactElement, entry = '/', path = '*') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const wrap = (el: ReactElement) =>
    createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Routes, null, el));
  const page = (el: ReactElement) => createElement(Route, { path, element: el });
  act(() => root.render(wrap(page(element))));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, again: (next: ReactElement) => act(() => root.render(wrap(page(next)))) };
}

function viewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') && wide,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const click = (button: Element | undefined) =>
  act(() => void button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const buttonText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  ensureDom();
  viewport(true);
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 'test',
  });
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'token-a',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  stopAnswering();
  for (const unmount of mounted.splice(0)) unmount();
  window.matchMedia = realMatchMedia;
  globalThis.fetch = realFetch;
  useCapabilitiesStore.setState(capabilitiesBefore);
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('queues table', () => {
  const counts = (waiting = 1) => ({
    waiting,
    prioritized: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  });
  const queue = (name: string, over: { paused?: boolean; waiting?: number } = {}) => ({
    name,
    paused: over.paused ?? false,
    counts: counts(over.waiting),
  });
  const table = (rows: ReturnType<typeof queue>[], canOperate = true) =>
    createElement(QueuesTable, {
      rows,
      hasData: true,
      error: null,
      search: '',
      sortCol: null,
      sortDir: 'desc',
      bulkBusy: false,
      busy: new Set<string>(),
      canOperate,
      onSort: () => {},
      onToggle: () => {},
    });
  const arrivals = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map((tr) =>
      tr.style.getPropertyValue('--i')
    );

  test('the rows of the first load arrive in order; a row a poll adds later does not', () => {
    const { host, again } = mount(table([queue('a'), queue('b')]));
    expect(arrivals(host)).toEqual(['0', '1']);
    again(table([queue('a'), queue('b'), queue('c')]));
    expect(count(host, 'tbody tr')).toBe(3);
    expect(arrivals(host)).toEqual(['0', '1']);
  });

  test('a poll that changes nothing washes nothing, and a changed count washes only its cell', () => {
    const { host, again } = mount(table([queue('a')]));
    expect(count(host, '.motion-flash')).toBe(0);
    again(table([queue('a')]));
    expect(count(host, '.motion-flash')).toBe(0);
    again(table([queue('a', { waiting: 7 })]));
    expect([...host.querySelectorAll('.motion-flash')].map((n) => n.textContent)).toEqual(['7']);
  });

  test('the row action names its queue, and a viewer is shown none', () => {
    const { host, again } = mount(table([queue('orders'), queue('mail', { paused: true })]));
    const labels = [...host.querySelectorAll('tbody button')].map((b) =>
      b.getAttribute('aria-label')
    );
    expect(labels).toEqual(['Pause queue, orders', 'Resume queue, mail']);
    again(table([queue('orders')], false));
    expect(count(host, 'tbody button')).toBe(0);
  });
});

describe('queue lifecycle', () => {
  const lifecycle = (over: Partial<Parameters<typeof QueueLifecycle>[0]['counts']> = {}) =>
    createElement(QueueLifecycle, {
      counts: {
        waiting: 4,
        prioritized: 1,
        active: 2,
        completed: 9,
        failed: 0,
        delayed: 3,
        ...over,
      },
    });

  test('shows the figures, one sentence for a screen reader, and Failed only while some are recorded', () => {
    const { host, again } = mount(lifecycle());
    const text = host.textContent ?? '';
    for (const word of ['Ready', 'Active', 'Completed', 'Delayed']) expect(text).toContain(word);
    expect(text).toContain('4 waiting · 1 prioritized');
    expect(text).not.toContain('Failed');
    expect(host.querySelector('p.sr-only')?.textContent).toBe(
      '5 ready (4 waiting, 1 prioritized). 2 active now, 9 completed. 3 delayed for later.'
    );
    again(lifecycle({ failed: 6 }));
    expect(host.textContent).toContain('Failed');
    expect(host.querySelector('p.sr-only')?.textContent).toContain('6 failed.');
  });

  test('a poll with the same counts sends no comet, and a rise in completed sends one down its line', () => {
    const { host, again } = mount(lifecycle());
    again(lifecycle());
    expect(count(host, '.motion-comet, .motion-comet-y')).toBe(0);
    again(lifecycle({ completed: 10 }));
    expect(count(host, '.motion-comet')).toBe(1);
  });

  test('narrow: one column with the lines running down', () => {
    viewport(false);
    const { host } = mount(lifecycle({ failed: 2 }));
    expect(count(host, '[style*="grid-template-columns"]')).toBe(0);
    expect(host.textContent).toContain('Failed');
  });
});

describe('asking in the page', () => {
  test('Pause all asks in the page, pauses on yes, and sends nothing on no', async () => {
    const pauses: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json([queueSummaryEntry('q1')]));
      if (url.endsWith('/pause') && init?.method === 'POST') {
        pauses.push(url);
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${url}` }, 500));
    }) as typeof fetch;

    stopAnswering = answerConfirms(false).stop;
    const { host } = mount(createElement(QueuesOverview));
    await settle(20);
    click(buttonText(host, 'Pause all'));
    await settle(20);
    expect(pauses).toHaveLength(0);

    stopAnswering();
    const yes = answerConfirms(true);
    stopAnswering = yes.stop;
    click(buttonText(host, 'Pause all'));
    await settle(20);
    expect(pauses).toHaveLength(1);
    expect(yes.questions).toEqual([
      { question: 'Pause 1 queue(s)?', confirmLabel: 'Pause queues', danger: undefined },
    ]);
  });

  test('Run delayed jobs asks with its own verb, and no from the dialog sends nothing', async () => {
    const posts: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      if (url.endsWith('/queues/summary'))
        return Promise.resolve(json([queueSummaryEntry('orders')]));
      if (url.includes('/dashboard/queues/orders'))
        return Promise.resolve(json(queueDetail('orders')));
      if (url.endsWith('/stall-config'))
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      if (url.endsWith('/dlq-config'))
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      if (url.includes('/jobs/list')) return Promise.resolve(json({ ok: true, jobs: [] }));
      return Promise.resolve(json({ ok: false, error: `Unexpected ${url}` }, 500));
    }) as typeof fetch;

    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const { host } = mount(
      createElement(QueueDetailPro),
      '/queues/orders?tab=settings',
      '/queues/:name'
    );
    await settle(20);
    click(buttonText(host, 'Run delayed jobs'));
    await settle(20);
    expect(no.questions.map((q) => q.confirmLabel)).toEqual(['Run delayed jobs']);
    expect(posts).toHaveLength(0);
  });

  test('the Overview and Settings tabs are addresses, and the open one is marked', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary'))
        return Promise.resolve(json([queueSummaryEntry('orders')]));
      if (url.includes('/dashboard/queues/orders'))
        return Promise.resolve(json(queueDetail('orders')));
      if (url.endsWith('/stall-config'))
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      if (url.endsWith('/dlq-config'))
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      return Promise.resolve(json({ ok: true, jobs: [] }));
    }) as typeof fetch;

    const { host } = mount(createElement(QueueDetailPro), '/queues/orders', '/queues/:name');
    await settle(20);
    const tabs = [...host.querySelectorAll('nav[aria-label="Page section"] a')];
    expect(
      tabs.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])
    ).toEqual([
      ['Overview', '/queues/orders', 'page'],
      ['Settings', '/queues/orders?tab=settings', null],
    ]);
    expect(host.textContent).toContain("Where this queue's jobs are");
  });
});
