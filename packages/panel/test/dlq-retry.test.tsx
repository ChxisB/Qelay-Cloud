import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { DlqPro } from '../src/pages/control/DlqPro';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

// Retrying failed jobs from the DLQ page: one job with the version the page read, up to 500 after a question, never a
// flow member, and no button where the server has closed it or the caller may only look.

const realFetch = globalThis.fetch;
const mounted: Array<() => void> = [];
let stopAnswering = () => {};
let posts: Array<{ url: string; body: unknown }> = [];
let entries: unknown[] = [];

const OPERATOR: Capabilities = { ...DEMO_CAPABILITIES, unsupported: [] };
const serveCaps = (caps: Capabilities) =>
  useCapabilitiesStore.setState({ status: 'ready', caps, error: null, key: 'test' });

const entry = (id: string, job: Record<string, unknown> = {}) => ({
  job: { id, queue: 'orders', name: 'send-email', attempts: 1, version: 4, ...job },
  enteredAt: 1_000,
  reason: 'explicit_fail',
  error: 'boom',
});

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return Promise.resolve(Response.json({ ok: true, count: 2, remaining: 5, done: false }));
    }
    if (url.includes('/dashboard/queues')) {
      const queues = [
        { name: 'orders', waiting: 0, delayed: 0, active: 0, dlq: entries.length, paused: false },
      ];
      return Promise.resolve(
        Response.json({ ok: true, queues, total: 1, limit: 500, offset: 0, timestamp: Date.now() })
      );
    }
    if (url.includes('/dlq/stats')) {
      return Promise.resolve(
        Response.json({ ok: true, stats: { byReason: { explicit_fail: 2 }, pendingRetry: 0 } })
      );
    }
    if (url.includes('/dlq?')) {
      return Promise.resolve(Response.json({ ok: true, entries, total: entries.length }));
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(MemoryRouter, { initialEntries: ['/dlq?queue=orders'] }, createElement(DlqPro))
    )
  );
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const click = (el: Element | null | undefined) =>
  act(async () => void el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll('button')].find((b) =>
    label.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`)
  );

beforeEach(() => {
  ensureDom();
  posts = [];
  entries = [entry('dead-1'), entry('dead-2'), entry('child-1', { parentId: 'p1' })];
  serve();
  serveCaps(OPERATOR);
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 20,
  });
});

afterEach(() => {
  stopAnswering();
  stopAnswering = () => {};
  for (const unmount of mounted.splice(0)) unmount();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('retrying from the DLQ page', () => {
  test('a row Retry sends the version the page read, and a flow member has no button', async () => {
    const host = mount();
    await settle(80);
    await click(button(host, /^Retry job dead-1/));
    await settle(20);
    expect(posts).toEqual([
      { url: 'http://server.test/queues/orders/dlq/dead-1/retry', body: { expectedVersion: 4 } },
    ]);
    expect(button(host, /^Retry job child-1/)).toBeUndefined();
    expect(host.textContent).toContain('In a flow');
  });

  test('Retry up to 500 asks first; a no sends nothing, a yes sends the queue name as confirm', async () => {
    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const host = mount();
    await settle(80);
    await click(button(host, /Retry up to 500/));
    await settle(20);
    expect(no.questions.map((q) => q.confirmLabel)).toEqual(['Retry jobs']);
    expect(no.questions[0]?.question).toContain('"orders"');
    expect(posts).toEqual([]);
    no.stop();

    const yes = answerConfirms(true);
    stopAnswering = yes.stop;
    await click(button(host, /Retry up to 500/));
    await settle(20);
    expect(posts).toEqual([
      {
        url: 'http://server.test/queues/orders/dlq/retry',
        body: { confirm: 'orders', limit: 500 },
      },
    ]);
  });

  test('a server that lists dlq-retry as unsupported gets no button, and the page says why', async () => {
    serveCaps({ ...OPERATOR, unsupported: ['dlq-retry'] });
    const host = mount();
    await settle(80);
    expect(button(host, /Retry/)).toBeUndefined();
    expect(host.textContent).toContain('switched off on this server');
  });

  test('a viewer gets no button', async () => {
    serveCaps({ ...OPERATOR, principal: { role: 'viewer' } });
    const host = mount();
    await settle(80);
    expect(button(host, /Retry/)).toBeUndefined();
  });
});
