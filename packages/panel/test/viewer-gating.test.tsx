import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { CronManager } from '../src/pages/control/CronManager';
import { DlqPro } from '../src/pages/control/DlqPro';
import { JobActionsPanel } from '../src/pages/control/job/JobActionsPanel';
import { JobsPro } from '../src/pages/control/JobsPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const OPERATOR: Capabilities = {
  ...DEMO_CAPABILITIES,
  transport: { name: 'pubsub', maxDeliverDelayMs: null, ordering: 'none' },
  unsupported: [],
};
const VIEWER: Capabilities = { ...OPERATOR, principal: { role: 'viewer' } };

const serveCaps = (caps: Capabilities) =>
  useCapabilitiesStore.setState({ status: 'ready', caps, error: null, key: 'test' });

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
const routed = (element: ReactElement, path = '/') =>
  mount(createElement(MemoryRouter, { initialEntries: [path] }, element));

const JOBS = [
  { id: 'delayed-1', name: 'send-email', state: 'delayed', priority: 0, createdAt: Date.now() },
  { id: 'done-1', name: 'send-email', state: 'completed', startedAt: 1000, completedAt: 1003 },
];

/** One queue with two jobs and one cron: the pages that mix reading with changing. */
function serve() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/queues/summary')) {
      return Promise.resolve(
        Response.json([
          {
            name: 'orders',
            paused: false,
            counts: { waiting: 0, prioritized: 0, active: 0, completed: 1, failed: 0, delayed: 1 },
          },
        ])
      );
    }
    if (url.includes('/queues/orders/jobs/list?')) {
      return Promise.resolve(Response.json({ ok: true, jobs: JOBS }));
    }
    if (url.endsWith('/crons')) {
      return Promise.resolve(
        Response.json({
          ok: true,
          crons: [
            {
              name: 'nightly',
              queue: 'orders',
              schedule: '0 3 * * *',
              nextRun: Date.now() + 60_000,
              executions: 2,
            },
          ],
        })
      );
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 20,
  });
  serve();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('button, a, input[type="checkbox"]')].map(
    (el) => el.getAttribute('aria-label') ?? el.textContent ?? ''
  );

describe('the job list for a viewer', () => {
  test('an operator is offered Add job, Bulk add, selection and Promote', async () => {
    serveCaps(OPERATOR);
    const { host, unmount } = routed(createElement(JobsPro), '/jobs');
    await settle(60);
    expect(host.querySelector('a[href="/add-job"]')).not.toBeNull();
    expect(host.querySelector('a[href="/jobs/bulk-add"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="Select all jobs on this page"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label^="Promote job"]')).not.toBeNull();
    unmount();
  });

  test('a viewer reads the list and is offered nothing that changes it', async () => {
    serveCaps(VIEWER);
    const { host, unmount } = routed(createElement(JobsPro), '/jobs');
    await settle(60);
    expect(host.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(host.querySelector('a[href="/add-job"]')).toBeNull();
    expect(host.querySelector('a[href="/jobs/bulk-add"]')).toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Promote job"]')).toBeNull();
    unmount();
  });

  test('nothing is offered until the server has said what the caller may do', async () => {
    useCapabilitiesStore.setState({ status: 'loading', caps: VIEWER, error: null, key: 'test' });
    const { host, unmount } = routed(createElement(JobsPro), '/jobs');
    await settle(60);
    expect(host.querySelector('a[href="/add-job"]')).toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    unmount();
  });
});

describe('the cron list for a viewer', () => {
  test('an operator can create and delete', async () => {
    serveCaps(OPERATOR);
    const { host, unmount } = routed(createElement(CronManager), '/cron');
    await settle(60);
    expect(host.textContent).toContain('Create schedule');
    expect(labels(host)).toContain('Delete cron nightly');
    unmount();
  });

  test('a viewer sees the schedules, with no form and no delete', async () => {
    serveCaps(VIEWER);
    const { host, unmount } = routed(createElement(CronManager), '/cron');
    await settle(60);
    expect(host.textContent).toContain('nightly');
    expect(host.textContent).not.toContain('Create schedule');
    expect(labels(host)).not.toContain('Delete cron nightly');
    unmount();
  });
});

describe('the job inspector actions for a viewer', () => {
  const job = {
    id: 'delayed-1',
    queue: 'orders',
    name: 'send-email',
    state: 'delayed',
    version: 3,
    data: {},
  } as unknown as Parameters<typeof JobActionsPanel>[0]['job'];
  const noop = () => undefined;

  test('an operator gets the controls the state allows', () => {
    serveCaps(OPERATOR);
    const { host, unmount } = mount(
      createElement(JobActionsPanel, { job, busy: false, act: noop })
    );
    expect(host.textContent).toContain('Promote (run now)');
    unmount();
  });

  test('a viewer gets a sentence, not disabled controls', () => {
    serveCaps(VIEWER);
    const { host, unmount } = mount(
      createElement(JobActionsPanel, { job, busy: false, act: noop })
    );
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('can look at jobs but not change them');
    unmount();
  });
});

describe('the DLQ page draws no control it cannot run', () => {
  const buttons = (host: HTMLElement) => labels(host).map((label) => label.trim());
  const retry = (host: HTMLElement) =>
    buttons(host).filter((label) => label.startsWith('Retry up to'));

  test('an operator is offered the bulk retry and never a purge: the server has no bulk purge', async () => {
    serveCaps(OPERATOR);
    const page = routed(createElement(DlqPro));
    await settle();
    expect(retry(page.host)).toEqual(['Retry up to 500']);
    expect(buttons(page.host).filter((label) => label.startsWith('Purge'))).toEqual([]);
    expect(buttons(page.host)).toContain('Export this page to CSV');
    page.unmount();
  });

  test('a viewer is offered neither', async () => {
    serveCaps(VIEWER);
    const page = routed(createElement(DlqPro));
    await settle();
    expect(retry(page.host)).toEqual([]);
    expect(buttons(page.host)).toContain('Export this page to CSV');
    page.unmount();
  });

  test('where the server lists dlq-retry as unsupported, the page draws no retry', async () => {
    serveCaps({ ...OPERATOR, unsupported: ['dlq-retry'] });
    const page = routed(createElement(DlqPro));
    await settle();
    expect(retry(page.host)).toEqual([]);
    page.unmount();
  });
});
