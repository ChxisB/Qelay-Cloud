import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { formatNumber } from '../src/lib/format';
import { MetricsPro } from '../src/pages/control/MetricsPro';
import { UsagePro } from '../src/pages/control/UsagePro';
import { WorkersPro } from '../src/pages/control/WorkersPro';
import { ensureDom, settle } from './domSetup';
import { dashboardOverview } from './fixtures/dashboard-overview';

const originalFetch = globalThis.fetch;
const mounted = new Set<() => void>();

const json = (body: unknown, status = 200) => Response.json(body, { status });

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(createElement(MemoryRouter, null, element)));
  return { host, unmount };
}

const worker = (id: string, name: string, queues: string[]) => ({
  id,
  name,
  queues,
  concurrency: 1,
  hostname: 'worker.test',
  pid: 42,
  status: 'active',
  registeredAt: Date.now() - 10_000,
  activeJobs: 0,
  processedJobs: 8,
  failedJobs: 0,
  lastSeen: Date.now() - 2_000,
  currentJob: null,
  uptime: 10_000,
});

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: 'http://pro.test', token: '', agentToken: '' });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('the dashboard read pages say so when the server is down or full', () => {
  test('Metrics reports an initial transport failure and exposes retry', async () => {
    globalThis.fetch = async () => json({ error: 'metrics unavailable' }, 503);
    const view = render(createElement(MetricsPro));
    await settle(10);
    expect(view.host.textContent).toContain('metrics unavailable');
    expect(
      [...view.host.querySelectorAll('button')].some((button) => button.textContent === 'Retry')
    ).toBe(true);
  });

  test('Usage renders runtime and an explicit disk-full diagnostic', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/storage'))
        return json({
          ok: true,
          data: { diskFull: true, error: 'ENOSPC', since: Date.now() - 60_000 },
        });
      if (url.endsWith('/queues/summary')) return json([]);
      return json(dashboardOverview());
    }) as typeof fetch;
    const view = render(createElement(UsagePro));
    await settle(10);
    expect(view.host.textContent).toContain(formatNumber(2_000));
    expect(view.host.textContent).toContain('ENOSPC');
  });

  test('Workers renders registry details and a fallback label for an unnamed worker', async () => {
    globalThis.fetch = (async () =>
      json({
        ok: true,
        data: { workers: [worker('worker-a', 'mailer', ['emails']), worker('worker-b', '', [])] },
      })) as typeof fetch;
    const view = render(createElement(WorkersPro));
    await settle(10);
    expect(view.host.textContent).toContain('mailer');
    expect(view.host.textContent).toContain('worker-b');
    expect(view.host.textContent).toContain('emails');
  });

  test('Workers and Usage fail closed when no first snapshot is available', async () => {
    globalThis.fetch = async () => json({ error: 'unreachable' }, 500);
    const workers = render(createElement(WorkersPro));
    const usage = render(createElement(UsagePro));
    await settle(10);
    expect(workers.host.textContent).toContain('unreachable');
    expect(usage.host.textContent).toContain('unreachable');
  });
});
