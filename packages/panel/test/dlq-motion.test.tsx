import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { FAIL_CLOSED } from '../src/lib/capabilities/types';
import { BulkAddJobs } from '../src/pages/control/BulkAddJobs';
import { DlqPro } from '../src/pages/control/DlqPro';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

// The DLQ board and the Bulk add file pick: rows that arrive once, queue pills that say which is chosen, no control for
// what the server cannot do, and a file pick that asks in the page before it replaces typed input. happy-dom plays no
// animation, so these check what is drawn, what is asked and what is read.

const realFetch = globalThis.fetch;
const realFileReader = globalThis.FileReader;
const mounted: Array<() => void> = [];
let stopAnswering = () => {};

const queue = (name: string, dlq: number) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});
const entry = (id: string) => ({
  job: { id, queue: 'orders', name: 'send-email', attempts: 1 },
  enteredAt: 1_000,
  reason: 'failed',
  error: 'boom',
});
let entries: unknown[] = [];

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/dashboard/queues')) {
      const queues = [queue('orders', entries.length), queue('billing', 2)];
      return Promise.resolve(
        Response.json({ ok: true, queues, total: 2, limit: 500, offset: 0, timestamp: Date.now() })
      );
    }
    if (url.includes('/dlq/stats')) {
      return Promise.resolve(
        Response.json({
          ok: true,
          stats: { byReason: { failed: entries.length }, pendingRetry: 0 },
        })
      );
    }
    if (url.includes('/dlq?')) {
      return Promise.resolve(Response.json({ ok: true, entries, total: entries.length }));
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
}

function mount(element: ReactElement, entry = '/dlq?queue=orders') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [entry] }, element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const click = (el: Element | null | undefined) =>
  act(async () => void el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  ensureDom();
  entries = [entry('dead-1'), entry('dead-2')];
  serve();
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
  globalThis.FileReader = realFileReader;
  window.FileReader = realFileReader;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('DLQ board', () => {
  test('the rows of the first load arrive in order; a row a poll adds later does not', async () => {
    const host = mount(createElement(DlqPro));
    await settle(80);
    const arrivals = () =>
      [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map((tr) =>
        tr.style.getPropertyValue('--i')
      );
    expect(arrivals()).toEqual(['0', '1']);
    entries = [...entries, entry('dead-3')];
    await settle(80);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(arrivals()).toEqual(['0', '1']);
  });

  test('the queue pills say which queue is chosen, and choosing another moves it', async () => {
    const host = mount(createElement(DlqPro));
    await settle(80);
    const group = host.querySelector('[role="group"][aria-label="DLQ by queue"]');
    const pills = [...(group?.querySelectorAll('button') ?? [])];
    expect(pills.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['orders2', 'true'],
      ['billing2', 'false'],
    ]);
    await click(pills[1]);
    await settle(40);
    expect(
      [...host.querySelectorAll('[aria-label="DLQ by queue"] button')].map((b) =>
        b.getAttribute('aria-pressed')
      )
    ).toEqual(['false', 'true']);
  });

  test('before the server has said what may be done, draws no retry or purge button', async () => {
    useCapabilitiesStore.setState({ status: 'loading', caps: FAIL_CLOSED, error: null, key: null });
    const host = mount(createElement(DlqPro));
    await settle(80);
    const labels = [...host.querySelectorAll('button')].map((b) =>
      `${b.textContent} ${b.getAttribute('aria-label') ?? ''}`.trim()
    );
    expect(labels.filter((label) => /Retry|Purge/.test(label))).toEqual([]);
  });
});

describe('Bulk add file pick', () => {
  /** Reads the picked file at once, as the browser would a moment later. */
  class InstantReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    abort() {}
    readAsText(file: { name: string }) {
      this.result = `[{"data":{"from":"${file.name}"}}]`;
      queueMicrotask(() => this.onload?.());
    }
  }

  const pick = (input: HTMLInputElement, name: string) => {
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name, size: 10 }] });
    return act(async () => void input.dispatchEvent(new window.Event('change', { bubbles: true })));
  };
  // happy-dom does not drive React's change plugin for a controlled textarea: set the value, then call its onChange prop.
  const typeInto = (textarea: HTMLTextAreaElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        value
      );
      const key = Object.getOwnPropertyNames(textarea).find((k) => k.startsWith('__reactProps$'));
      const props = (textarea as unknown as Record<string, unknown>)[key ?? ''] as {
        onChange?: (event: { target: typeof textarea }) => void;
      };
      props.onChange?.({ target: textarea });
    });

  const setup = () => {
    globalThis.FileReader = InstantReader as unknown as typeof FileReader;
    window.FileReader = InstantReader as unknown as typeof FileReader;
    const host = mount(createElement(BulkAddJobs), '/add');
    return {
      input: host.querySelector<HTMLInputElement>('[name="jobs-file"]')!,
      textarea: host.querySelector<HTMLTextAreaElement>('[name="jobs-json"]')!,
    };
  };

  test('an empty box takes the file without asking', async () => {
    const yes = answerConfirms();
    stopAnswering = yes.stop;
    const { input, textarea } = setup();
    await pick(input, 'jobs.json');
    await settle(10);
    expect(yes.questions).toEqual([]);
    expect(textarea.value).toBe('[{"data":{"from":"jobs.json"}}]');
  });

  test('typed input is asked about first; a cancel keeps it, a yes reads the file', async () => {
    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const { input, textarea } = setup();
    await typeInto(textarea, '[{"data":{"mine":true}}]');

    await pick(input, 'jobs.json');
    await settle(10);
    expect(no.questions).toEqual([
      { question: 'Replace the current input with "jobs.json"?', confirmLabel: 'Replace' },
    ]);
    expect(textarea.value).toBe('[{"data":{"mine":true}}]');

    no.stop();
    const yes = answerConfirms(true);
    stopAnswering = yes.stop;
    await pick(input, 'jobs.json');
    await settle(10);
    expect(textarea.value).toBe('[{"data":{"from":"jobs.json"}}]');
  });
});
