import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { JobsPro } from '../src/pages/control/JobsPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const FULL_ID = '019f252b-8716-7000-bbec-d8c65e09f340';
const JOBS = [
  {
    id: FULL_ID,
    name: 'send-email',
    state: 'failed',
    priority: 3,
    attempts: 1,
    maxAttempts: 3,
    createdAt: Date.now() - 5_000,
    data: { to: 'user8@example.com', subject: 'Welcome 8' },
  },
  { id: 'delayed-1', name: 'send-email', state: 'delayed', priority: 0, createdAt: Date.now() },
  { id: 'done-1', name: 'send-email', state: 'completed', startedAt: 1000, completedAt: 1003 },
];

/** Serves one queue; `jobs` is what `/jobs/list` returns, and every list URL is recorded. */
function serve(jobs: unknown[]) {
  const listUrls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/queues/summary')) {
      return Promise.resolve(
        Response.json([
          {
            name: 'orders',
            paused: false,
            counts: { waiting: 2, prioritized: 7, active: 0, completed: 4, failed: 2, delayed: 1 },
          },
        ])
      );
    }
    if (url.includes('/queues/orders/jobs/list?')) {
      listUrls.push(url);
      return Promise.resolve(Response.json({ ok: true, jobs }));
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
  return listUrls;
}

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const renderJobs = (path = '/jobs') =>
  mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(JobsPro)));

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));

/** Fires the controlled input's React onChange directly; happy-dom's input events don't reach it. */
function type(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
    element,
    value
  );
  const propsKey = Object.getOwnPropertyNames(element).find((key) =>
    key.startsWith('__reactProps$')
  );
  const props = propsKey
    ? ((element as unknown as Record<string, unknown>)[propsKey] as {
        onChange?: (event: { target: HTMLInputElement }) => void;
      })
    : undefined;
  if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
  props.onChange({ target: element });
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 20,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('JobsPro layout', () => {
  test('titles the page "Jobs", counts the queue, and links to Add job and Bulk add', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    expect(host.querySelector('h1')?.textContent).toBe('Jobs');
    expect(host.textContent).toContain('16 jobs in orders · updated');
    expect(host.querySelector('a[href="/add-job"]')?.textContent).toContain('Add job');
    expect(host.querySelector('a[href="/jobs/bulk-add"]')?.textContent).toBe('Bulk add');
    unmount();
  });

  test('state tabs carry per-state counts; flow-blocked and paused have none', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    const group = host.querySelector('[role="group"][aria-label="Job state"]');
    expect(group?.textContent).toContain('All16');
    expect(group?.textContent).toContain('Prioritized7');
    expect(group?.textContent).toContain('Failed2');
    expect(button(host, 'Flow-blocked')?.textContent).toBe('Flow-blocked');
    expect(button(host, 'All')?.getAttribute('aria-pressed')).toBe('true');
    unmount();
  });

  test('picking a tab refetches that state and narrows the headline', async () => {
    const urls = serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    await act(async () => button(host, 'Failed')?.click());
    await settle(60);
    expect(urls.at(-1)).toContain('states=failed');
    expect(button(host, 'Failed')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('2 failed jobs in orders');
    unmount();
  });

  test('a row keeps the whole ID in the DOM, with name and payload as its second line', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain(FULL_ID);
    expect(rows[0].textContent).toContain('send-email · user8@example.com · Welcome 8');
    expect(rows[0].textContent).toContain('1 / 3');
    expect(rows[0].textContent).toContain('failed');
    expect(rows[2].textContent).toContain('3ms');
    unmount();
  });

  test('the selection bar offers Promote for delayed jobs, never Retry or Remove', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);
    expect(button(host, 'Clear')).toBeUndefined();

    await act(async () =>
      host.querySelector<HTMLInputElement>('input[aria-label="Select job delayed-1"]')?.click()
    );
    expect(host.textContent).toContain('1 selected');
    expect(button(host, 'Promote')).toBeDefined();
    expect(button(host, 'Retry')).toBeUndefined();
    expect(button(host, 'Remove')).toBeUndefined();

    await act(async () => button(host, 'Clear')?.click());
    expect(host.textContent).not.toContain('1 selected');
    unmount();
  });

  test('selecting only non-delayed jobs says nothing applies', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    await act(async () =>
      host.querySelector<HTMLInputElement>(`input[aria-label="Select job ${FULL_ID}"]`)?.click()
    );
    expect(button(host, 'Promote')).toBeUndefined();
    expect(host.textContent).toContain('No actions apply to the selected job states.');
    unmount();
  });

  test('an empty queue explains itself', async () => {
    serve([]);
    const { host, unmount } = renderJobs();
    await settle(60);

    expect(host.textContent).toContain('No jobs in orders');
    expect(host.textContent).toContain('Jobs appear here while a worker is processing them.');
    expect(host.textContent).toContain('No jobs on this page');
    unmount();
  });

  test('the filter searches the page and says when nothing matches', async () => {
    serve(JOBS);
    const { host, unmount } = renderJobs();
    await settle(60);

    const input = host.querySelector<HTMLInputElement>('input[name="jobs-id-filter"]');
    if (!input) throw new Error('Missing filter field');
    await act(async () => type(input, 'welcome 8'));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('1 of 3 on this page match');

    await act(async () => type(input, 'zzz'));
    expect(host.textContent).toContain('No matching jobs');
    unmount();
  });
});
