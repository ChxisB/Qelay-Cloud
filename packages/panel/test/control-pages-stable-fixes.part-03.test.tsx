import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { DlqControl } from '../src/pages/control/DlqControl';
import { DlqPro } from '../src/pages/control/DlqPro';
import { JobsPro } from '../src/pages/control/JobsPro';
import {
  byName,
  change,
  json,
  refocus,
  render,
  settle,
  waitFor,
  installStableFixHooks,
} from './control-pages-stable-fixes.helpers';

// Regression tests for selects stuck on values that have no <option> (item 11).

const realFetch = globalThis.fetch;

installStableFixHooks();

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const dashboardQueue = (name: string, dlq: number) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});

const dlqEntry = (id: string, reason: string) => ({
  job: { id, queue: 'orders', attempts: 1 },
  enteredAt: 1_000,
  reason,
  error: 'boom',
});

/** A DLQ server whose `stalled` entry and the `orders` queue can disappear. */
function dlqServer() {
  const state = { stalledGone: false, queues: [dashboardQueue('orders', 2)] };
  const dlqUrls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/dashboard/queues?')) {
      return Promise.resolve(
        json({
          ok: true,
          queues: state.queues,
          total: state.queues.length,
          limit: 500,
          offset: 0,
          timestamp: Date.now(),
        })
      );
    }
    const byReason = state.stalledGone ? { failed: 1 } : { failed: 1, stalled: 1 };
    if (url.includes('/dlq/stats')) {
      return Promise.resolve(json({ ok: true, stats: { byReason, pendingRetry: 0 } }));
    }
    if (url.includes('/dlq?')) {
      dlqUrls.push(url);
      const entries = state.stalledGone
        ? [dlqEntry('dead-failed', 'failed')]
        : [dlqEntry('dead-failed', 'failed'), dlqEntry('dead-stalled', 'stalled')];
      return Promise.resolve(json({ ok: true, entries, total: entries.length }));
    }
    return Promise.resolve(json({ ok: false, error: `Unexpected ${url}` }, 500));
  }) as typeof fetch;
  return { state, dlqUrls };
}

describe('JobsPro ?queue= deep link', () => {
  test('a queue missing from the summary falls back to a listed queue', async () => {
    const listUrls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 1,
                prioritized: 0,
                active: 0,
                completed: 0,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      if (url.endsWith('/stats')) return Promise.resolve(json({ ok: false, error: 'n/a' }, 503));
      if (url.includes('/jobs/list?')) {
        listUrls.push(url);
        if (url.includes('/queues/orders/')) {
          return Promise.resolve(
            json({ ok: true, jobs: [{ id: 'job-1', queue: 'orders', state: 'waiting' }] })
          );
        }
        return Promise.resolve(json({ ok: false, error: 'Queue not found' }, 404));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${url}` }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs?queue=gone'] }, createElement(JobsPro))
    );
    await waitFor(() => view.host.textContent?.includes('job-1') === true);
    expect(byName<HTMLSelectElement>(view.host, 'jobs-queue').value).toBe('orders');
    expect(listUrls.at(-1)).toContain('/queues/orders/jobs/list?');
  });
});

describe('DLQ reason filters', () => {
  test('DlqPro resets a reason that no longer has entries to "all"', async () => {
    const server = dlqServer();
    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/dlq?queue=orders'] }, createElement(DlqPro))
    );
    await waitFor(() => view.host.textContent?.includes('dead-stalled') === true);
    const reason = byName<HTMLSelectElement>(view.host, 'dlq-reason-filter');
    change(reason, 'stalled');
    expect(view.host.textContent).not.toContain('dead-failed');

    server.state.stalledGone = true;
    refocus();
    await waitFor(() => view.host.textContent?.includes('dead-failed') === true);
    expect(byName<HTMLSelectElement>(view.host, 'dlq-reason-filter').value).toBe('all');
  });

  test('DlqControl resets a reason that no longer has entries to "all"', async () => {
    const server = dlqServer();
    const view = render(createElement(MemoryRouter, null, createElement(DlqControl)));
    await waitFor(() => view.host.textContent?.includes('dead-stalled') === true);
    change(byName(view.host, 'dlq-control-reason'), 'stalled');
    expect(view.host.textContent).not.toContain('dead-failed');

    server.state.stalledGone = true;
    refocus();
    await waitFor(() => view.host.textContent?.includes('dead-failed') === true);
    expect(byName<HTMLSelectElement>(view.host, 'dlq-control-reason').value).toBe('all');
  });
});

describe('DlqControl queue picker', () => {
  test('a selected queue that disappears from discovery is replaced by a live one', async () => {
    const server = dlqServer();
    const view = render(createElement(MemoryRouter, null, createElement(DlqControl)));
    await waitFor(() => server.dlqUrls.some((url) => url.includes('/queues/orders/dlq?')));
    expect(byName<HTMLSelectElement>(view.host, 'dlq-control-queue').value).toBe('orders');

    server.state.queues = [dashboardQueue('billing', 1)];
    refocus();
    await waitFor(() => server.dlqUrls.some((url) => url.includes('/queues/billing/dlq?')));
    await settle(10);
    expect(byName<HTMLSelectElement>(view.host, 'dlq-control-queue').value).toBe('billing');
    expect(server.dlqUrls.at(-1)).toContain('/queues/billing/dlq?');
  });
});
