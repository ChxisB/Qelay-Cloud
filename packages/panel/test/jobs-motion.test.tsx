import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { JobTimeline } from '../src/pages/control/job/JobTimeline';
import { JobInspector } from '../src/pages/control/JobInspector';
import { JobsPro } from '../src/pages/control/JobsPro';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

// The Jobs board: rows that arrive once, names that carry the end of the id, Promote asking first in the page, and the
// job's timeline drawn as a line with its entries. happy-dom plays no animation, so these check what is drawn, what is asked
// and what is sent.

const realFetch = globalThis.fetch;
const mounted: Array<() => void> = [];
let stopAnswering = () => {};

const delayed = (id: string) => ({ id, name: 'send-email', state: 'delayed', priority: 0 });
let jobs: unknown[] = [];
const posts: string[] = [];

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push(url);
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (url.endsWith('/queues/summary')) {
      return Promise.resolve(
        Response.json([
          {
            name: 'orders',
            paused: false,
            counts: { waiting: 0, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 3 },
          },
        ])
      );
    }
    if (url.includes('/queues/orders/jobs/list?')) {
      return Promise.resolve(Response.json({ ok: true, jobs }));
    }
    if (url.endsWith('/jobs/job-a/logs')) {
      return Promise.resolve(Response.json({ ok: true, data: { logs: [], count: 0 } }));
    }
    if (url.endsWith('/jobs/job-a')) {
      return Promise.resolve(
        Response.json({ ok: true, job: { id: 'job-a', queue: 'orders', state: 'delayed' } })
      );
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
}

function mount(element: ReactElement, entry = '/jobs') {
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
const buttonText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  ensureDom();
  jobs = [delayed('job-0001'), delayed('job-0002')];
  posts.length = 0;
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
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('jobs table', () => {
  const arrivals = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map((tr) =>
      tr.style.getPropertyValue('--i')
    );

  test('the rows of the first load arrive in order; a row a poll adds later does not', async () => {
    const host = mount(createElement(JobsPro));
    await settle(80);
    expect(arrivals(host)).toEqual(['0', '1']);
    jobs = [...jobs, delayed('job-0003')];
    await settle(80);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(arrivals(host)).toEqual(['0', '1']);
  });

  test('a row names its job by the end of its id', async () => {
    const host = mount(createElement(JobsPro));
    await settle(80);
    expect(host.querySelector('input[aria-label="Select job 0001"]')).not.toBeNull();
    expect(host.querySelector('a[aria-label="Inspect job 0001"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Promote job 0001"]')).not.toBeNull();
  });

  test('a poll that changes nothing washes no tile count', async () => {
    const host = mount(createElement(JobsPro));
    await settle(80);
    await settle(80);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);
  });
});

describe('Promote asks first', () => {
  test('the bulk bar asks for the count; a cancel sends nothing, a yes promotes', async () => {
    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const host = mount(createElement(JobsPro));
    await settle(80);
    await click(host.querySelector('input[aria-label="Select job 0001"]'));
    expect(host.querySelector('[aria-label="Selected jobs"]')).not.toBeNull();

    await click(buttonText(host, 'Promote'));
    await settle(10);
    expect(no.questions).toEqual([
      { question: 'Promote 1 delayed job?', confirmLabel: 'Promote 1', danger: undefined },
    ]);
    expect(posts).toEqual([]);

    no.stop();
    const yes = answerConfirms(true);
    stopAnswering = yes.stop;
    await click(buttonText(host, 'Promote'));
    await settle(30);
    expect(posts.map((url) => url.split('/jobs/')[1])).toEqual(['job-0001/promote']);
  });

  test('a row asks about one job', async () => {
    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const host = mount(createElement(JobsPro));
    await settle(80);
    await click(host.querySelector('button[aria-label="Promote job 0002"]'));
    await settle(10);
    expect(no.questions.map((q) => q.question)).toEqual(['Promote 1 delayed job?']);
    expect(posts).toEqual([]);
  });

  test("the job's own page asks, and sends nothing on a cancel", async () => {
    const no = answerConfirms(false);
    stopAnswering = no.stop;
    const host = mount(createElement(JobInspector), '/job?id=job-a');
    await settle(80);
    await click(buttonText(host, 'Promote (run now)'));
    await settle(10);
    expect(no.questions).toEqual([
      { question: 'Promote this job?', confirmLabel: 'Promote', danger: undefined },
    ]);
    expect(posts).toEqual([]);
  });
});

describe('job timeline', () => {
  const entries = [
    { state: 'waiting', timestamp: 1_000 },
    { state: 'active', timestamp: 2_000, attempt: 1, worker: 'w-1' },
    { state: 'failed', timestamp: 3_000, attempt: 1, error: 'boom' },
  ];

  test('draws a line down the entries, which arrive one after the other', () => {
    const host = mount(createElement(JobTimeline, { timeline: entries }));
    expect(host.querySelectorAll('.motion-draw-y')).toHaveLength(1);
    const items = [...host.querySelectorAll<HTMLElement>('ol[aria-label] > li')];
    expect(items.map((li) => li.style.getPropertyValue('--i'))).toEqual(['0', '1', '2']);
    expect(items.every((li) => li.classList.contains('motion-arrive'))).toBe(true);
    expect(items[2].textContent).toContain('boom');
  });

  test('says so when nothing is recorded, and draws no line', () => {
    const host = mount(createElement(JobTimeline, { timeline: [] }));
    expect(host.textContent).toContain('No state transitions recorded yet.');
    expect(host.querySelectorAll('.motion-draw-y')).toHaveLength(0);
  });
});
