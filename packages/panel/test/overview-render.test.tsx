import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { OverviewPro } from '../src/pages/control/OverviewPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

interface Scenario {
  dlq: number;
  failed: number;
  dlqQueues: { name: string; dlq: number }[];
}

const counts = (failed: number) => ({
  waiting: 5,
  prioritized: 1,
  active: 2,
  completed: 11,
  failed,
  delayed: 3,
  'waiting-children': 0,
  paused: 0,
});

/** Answers every endpoint the Overview touches and counts /dashboard polls. */
function serve(s: Scenario) {
  const calls = { dashboard: 0 };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/dashboard')) {
      calls.dashboard += 1;
      return Promise.resolve(
        Response.json({
          ok: true,
          stats: {
            waiting: 5,
            active: 2,
            completed: 11,
            dlq: s.dlq,
            totalPushed: 50,
            totalPulled: 13,
            uptime: 60_000,
          },
          throughput: { pushPerSec: 1.5, pullPerSec: 0.5 },
          memory: { rss: 32 },
          crons: { total: 0 },
        })
      );
    }
    if (url.endsWith('/queues/summary')) {
      return Promise.resolve(
        Response.json([{ name: 'orders', paused: false, counts: counts(s.failed) }])
      );
    }
    if (url.includes('/dashboard/queues')) {
      return Promise.resolve(
        Response.json({
          ok: true,
          queues: s.dlqQueues.map((q) => ({
            name: q.name,
            waiting: 5,
            delayed: 3,
            active: 2,
            dlq: q.dlq,
            paused: false,
          })),
          total: s.dlqQueues.length,
          limit: 500,
          offset: 0,
          timestamp: 1,
        })
      );
    }
    if (url.endsWith('/health')) {
      return Promise.resolve(Response.json({ ok: true, version: '2.9.3' }));
    }
    if (url.includes('/events')) {
      return Promise.resolve(Response.json({ error: 'stream unavailable' }, { status: 404 }));
    }
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
  return calls;
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

const renderOverview = () => mount(createElement(MemoryRouter, null, createElement(OverviewPro)));

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);

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

describe('OverviewPro layout', () => {
  test('a healthy server shows no attention banner and no Failed tile', async () => {
    serve({ dlq: 0, failed: 0, dlqQueues: [{ name: 'orders', dlq: 0 }] });
    const { host, unmount } = renderOverview();
    await settle(40);
    expect(host.textContent).toContain('Server connected');
    expect(host.textContent).toContain('v2.9.3');
    expect(host.textContent).not.toContain('dead letter queue');
    expect(host.querySelector('a[href^="/dlq"]')).toBeNull();
    expect(host.textContent).not.toContain('recorded across queues');
    unmount();
  });

  test('dead-lettered jobs raise the banner with a deep link to that queue', async () => {
    serve({ dlq: 2, failed: 0, dlqQueues: [{ name: 'orders', dlq: 2 }] });
    const { host, unmount } = renderOverview();
    await settle(40);
    expect(host.textContent).toContain('2 jobs are in the orders dead letter queue');
    expect(host.querySelector('a[href="/dlq?queue=orders"]')?.textContent).toBe('Review DLQ');
    unmount();
  });

  test('failed jobs add the Failed tile and the failed-jobs banner', async () => {
    serve({ dlq: 0, failed: 4, dlqQueues: [{ name: 'orders', dlq: 0 }] });
    const { host, unmount } = renderOverview();
    await settle(40);
    expect(host.textContent).toContain('recorded across queues');
    expect(host.textContent).toContain('4 failed jobs recorded across your queues');
    expect(host.querySelector('a[href="/jobs?queue=orders&status=failed"]')).not.toBeNull();
    unmount();
  });

  test('the brand gradient is drawn exactly once on the screen', async () => {
    serve({ dlq: 0, failed: 0, dlqQueues: [{ name: 'orders', dlq: 0 }] });
    const { host, unmount } = renderOverview();
    await settle(40);
    const strokeGradients = [...host.querySelectorAll('linearGradient')].filter((g) =>
      g.querySelector('stop[stop-color="var(--brand-1)"]')
    );
    expect(strokeGradients).toHaveLength(1);
    unmount();
  });

  test('Pause stops polling, shows Paused, and Resume refetches at once', async () => {
    const calls = serve({ dlq: 0, failed: 0, dlqQueues: [{ name: 'orders', dlq: 0 }] });
    const { host, unmount } = renderOverview();
    await settle(60);
    expect(host.textContent).toContain('Live');

    await act(async () => button(host, 'Pause')?.click());
    await settle(30); // drain an in-flight tick
    expect(host.textContent).toContain('Paused');
    const frozenAt = calls.dashboard;
    await settle(120);
    expect(calls.dashboard).toBe(frozenAt);

    await act(async () => button(host, 'Resume')?.click());
    await settle(10);
    expect(calls.dashboard).toBeGreaterThan(frozenAt);
    expect(host.textContent).toContain('Live');
    unmount();
  });
});
