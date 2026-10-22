import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES, FAIL_CLOSED } from '../src/lib/capabilities/types';
import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const requested: string[] = [];

const COUNTS = {
  waiting: 1,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  prioritized: 0,
  'waiting-children': 0,
  paused: 0,
};

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requested.push(`${url.host}${url.pathname}`);
    const path = url.pathname;
    if (path === '/queues/summary')
      return Promise.resolve(Response.json([{ name: 'orders', paused: false, counts: COUNTS }]));
    if (path === '/queues/orders/stall-config')
      return Promise.resolve(
        Response.json({
          ok: true,
          config: { enabled: true, stallInterval: 30_000, maxStalls: 3, gracePeriod: 5_000 },
        })
      );
    if (path === '/queues/orders/dlq-config')
      return Promise.resolve(
        Response.json({
          ok: true,
          config: {
            autoRetry: false,
            autoRetryInterval: 3_600_000,
            maxAutoRetries: 3,
            maxAge: 604_800_000,
            maxEntries: 10_000,
          },
        })
      );
    if (path.includes('/jobs/list')) return Promise.resolve(Response.json({ ok: true, jobs: [] }));
    return Promise.resolve(
      Response.json({
        ok: true,
        name: 'orders',
        counts: COUNTS,
        paused: false,
        priorityCounts: {},
        dlqPreview: [],
        timestamp: 1,
      })
    );
  }) as typeof fetch;
}

const deployment = (hidden: string[]): Capabilities => ({ ...DEMO_CAPABILITIES, hidden });

async function render(caps: Capabilities) {
  useCapabilitiesStore.setState({ status: 'ready', caps, error: null, key: 'test' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/queues/orders?tab=settings'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/queues/:name', element: createElement(QueueDetailPro) })
        )
      )
    )
  );
  await settle(80);
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  ensureDom();
  requested.length = 0;
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
  serve();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

/** The card is the only part of the page that calls the local control agent, never the Control API. */
const agentCalls = () => requested.filter((entry) => entry.startsWith('localhost:6800'));

describe('the queue settings tab and the agent-backed operations card', () => {
  test('a deployment that lists queueOperations as hidden leaves the card out and calls no agent', async () => {
    const { host, unmount } = await render(deployment(['queueOperations']));
    expect(host.textContent).toContain('Pause or resume');
    expect(host.textContent).not.toContain('SDK operations');
    expect(agentCalls()).toEqual([]);
    unmount();
  });

  test('a deployment with a local agent still shows the card', async () => {
    const { host, unmount } = await render(deployment([]));
    expect(host.textContent).toContain('SDK operations');
    expect(agentCalls().length).toBeGreaterThan(0);
    unmount();
  });

  test('nothing is called before the server has said whether the card applies', async () => {
    useCapabilitiesStore.setState({
      status: 'loading',
      caps: FAIL_CLOSED,
      error: null,
      key: 'test',
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/queues/orders?tab=settings'] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/queues/:name', element: createElement(QueueDetailPro) })
          )
        )
      )
    );
    await settle(80);
    expect(agentCalls()).toEqual([]);
    act(() => root.unmount());
    host.remove();
  });
});
