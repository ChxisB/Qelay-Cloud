import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
let stopAnswering = () => {};
const mounted = new Set<() => void>();
const capabilitiesBefore = useCapabilitiesStore.getState();

const json = (body: unknown, status = 200) => Response.json(body, { status });

const counts = { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 };

/** What the Pro detail page reads for the queues in `waiting` (name to waiting count); `null` for anything it does not ask for. */
function read(url: string, waiting: Record<string, number> = { orders: 1 }): Response | null {
  if (url.endsWith('/queues/summary'))
    return json(Object.keys(waiting).map((name) => ({ name, paused: false, counts })));
  const detail = Object.keys(waiting).find((name) => url.includes(`/dashboard/queues/${name}`));
  if (detail) {
    return json({
      ok: true,
      name: detail,
      counts: { ...counts, waiting: waiting[detail], 'waiting-children': 0, paused: 0 },
      paused: false,
      priorityCounts: {},
      dlqPreview: [],
      timestamp: 1,
    });
  }
  if (url.endsWith('/stall-config'))
    return json({
      ok: true,
      config: { enabled: true, stallInterval: 30_000, maxStalls: 3, gracePeriod: 5_000 },
    });
  if (url.endsWith('/dlq-config'))
    return json({
      ok: true,
      config: {
        autoRetry: false,
        autoRetryInterval: 3_600_000,
        maxAutoRetries: 3,
        maxAge: 604_800_000,
        maxEntries: 10_000,
      },
    });
  if (url.includes('/jobs/list')) return json({ ok: true, jobs: [] });
  return null;
}

let go: (to: string) => void = () => {};
function Handle() {
  go = useNavigate();
  return null;
}

function open(queue: string, tab = 'settings') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.add(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/queues/${queue}?tab=${tab}`] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/queues/:name', element: createElement(QueueDetailPro) })
        ),
        createElement(Handle)
      )
    )
  );
  return host;
}

const pauseButton = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Pause'))!;

beforeEach(() => {
  ensureDom();
  // The settings and their Pause button are for an operator; a viewer is shown a note instead.
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 'test',
  });
  stopAnswering = answerConfirms().stop;
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'token-a',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  useCapabilitiesStore.setState(capabilitiesBefore);
  globalThis.fetch = realFetch;
  stopAnswering();
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('QueueDetailPro mutation safety', () => {
  test('a queue the registry does not list shows Not found and offers no controls', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      return Promise.resolve(
        url.endsWith('/queues/summary') ? json([]) : json({ ok: false, error: 'unexpected' }, 500)
      );
    }) as typeof fetch;

    const host = open('missing');
    await settle(12);

    expect(new Set(calls)).toEqual(new Set(['/queues/summary']));
    expect(host.textContent).toContain('Queue not found');
    expect(host.textContent).not.toContain('Pause');
    expect(host.textContent).not.toContain('Resume');
  });

  test('a failed refresh keeps the last data on screen but drops the Live badge', async () => {
    useConnectionStore.setState({ refreshMs: 60 });
    let summaries = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        summaries += 1;
        if (summaries > 1) return Promise.resolve(json({ error: 'refresh unavailable' }, 502));
      }
      return Promise.resolve(read(url) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('orders');
    await settle(30);
    const live = () => [...host.querySelectorAll('span')].some((n) => n.textContent === 'Live');
    expect(live()).toBe(true);

    await settle(120);
    expect(live()).toBe(false);
    expect(host.textContent).toContain('orders');
  });

  test('a malformed mutation ACK is an error, never a success', async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/queues/orders/pause'))
        return Promise.resolve(json({}));
      return Promise.resolve(read(url) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('orders');
    await settle(12);
    act(() => pauseButton(host).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(12);

    expect(host.textContent).toContain('Paused returned a malformed success response');
  });

  test('a double click on Pause sends one request', async () => {
    let pauses = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/queues/orders/pause')) {
        pauses += 1;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(read(url) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('orders');
    await settle(12);
    const pause = pauseButton(host);
    act(() => {
      pause.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      pause.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle(4);
    expect(pauses).toBe(1);
  });

  test("moving to another queue drops the old queue's late answer and its pending success", async () => {
    const waiting = { 'q-a': 1, 'q-b': 42 };
    let releasePause: (response: Response) => void = () => {};
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/queues/q-a/pause'))
        return new Promise<Response>((resolve) => (releasePause = resolve));
      return Promise.resolve(read(url, waiting) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('q-a');
    await settle(12);
    act(() => pauseButton(host).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    act(() => go('/queues/q-b?tab=settings'));
    await settle(25);
    await act(async () => {
      releasePause(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('q-b');
    expect(host.textContent).not.toContain('Paused ✓');
  });

  test("a late answer for the old queue cannot replace the new queue's numbers", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const waiting = { 'q-a': 99, 'q-b': 22 };
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues/q-a'))
        return new Promise<Response>((resolve) => (releaseOld = resolve));
      return Promise.resolve(read(url, waiting) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('q-a', 'overview');
    await settle(12);
    act(() => go('/queues/q-b?tab=overview'));
    await settle(25);
    expect(host.textContent).toContain('22');

    await act(async () => {
      releaseOld(read('/dashboard/queues/q-a', waiting)!);
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('22');
    expect(host.textContent).not.toContain('99');
  });

  test('a malformed refresh keeps the last snapshot and says the refresh failed', async () => {
    useConnectionStore.setState({ refreshMs: 60 });
    let details = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues/orders') && (details += 1) > 1)
        return Promise.resolve(json({ ok: true }));
      return Promise.resolve(
        read(url, { orders: 17 }) ?? json({ ok: false, error: 'unexpected' }, 500)
      );
    }) as typeof fetch;

    const host = open('orders', 'overview');
    await settle(30);
    expect(host.textContent).toContain('17');

    await settle(120);
    expect(host.textContent).toContain('Queue refresh failed');
    expect(host.textContent).toContain('17');
    expect(host.textContent).not.toContain('Something went wrong');
  });

  test('a success with a negative count is an error, never a success', async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(json({ ok: true, count: -1 }));
      return Promise.resolve(read(String(input)) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('orders');
    await settle(12);
    const run = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Run delayed jobs')
    )!;
    act(() => run.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(12);

    expect(host.textContent).toContain('returned an invalid count');
  });

  test('an incomplete 2xx detail body is a readable error, not a half-drawn page', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues/orders')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(read(url) ?? json({ ok: false, error: 'unexpected' }, 500));
    }) as typeof fetch;

    const host = open('orders');
    await settle(12);
    expect(host.textContent).toContain('Malformed queue detail response for "orders"');
    expect(host.textContent).not.toContain('Pause');
  });
});
