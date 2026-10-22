import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import type { DeploymentView, TransportView } from '../src/lib/ops/types';
import { useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { OverviewPro } from '../src/pages/control/OverviewPro';
import { route, stats } from './gateway.helpers';
import { deployment, queue, transport } from './ops.helpers';
import {
  afterEach,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  MemoryRouter,
  render,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

afterEach(() => {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 'test',
  });
  useAlertRuntimeStore.setState({ breaching: [] });
});

interface World {
  dlq?: number;
  failed?: number;
  paused?: boolean;
  deployment?: DeploymentView | 'down';
  transport?: TransportView | 'down';
  routes?: unknown[] | 'down';
}

/** A server that answers every call Home makes, and records the paths asked. */
function serveHome(world: World = {}) {
  const seen: string[] = [];
  const down = () => json({ ok: false, error: 'unavailable' }, 500);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === '/dashboard') {
      return json({
        ok: true,
        stats: {
          waiting: 5,
          active: 2,
          completed: 11,
          dlq: world.dlq ?? 0,
          totalPushed: 50,
          totalPulled: 13,
          uptime: 60_000,
        },
        throughput: { pushPerSec: 1.5, pullPerSec: 0.5 },
        memory: { rss: 32 },
        crons: { total: 3 },
      });
    }
    if (path === '/queues/summary') {
      return json([
        {
          name: 'orders',
          paused: world.paused ?? false,
          counts: {
            waiting: 5,
            prioritized: 0,
            active: 2,
            completed: 11,
            failed: world.failed ?? 0,
            delayed: 0,
          },
        },
      ]);
    }
    if (path === '/dashboard/queues') {
      return json({ ok: true, queues: [], total: 0, limit: 500, offset: 0, timestamp: 1 });
    }
    if (path === '/health') return json({ ok: true, version: '2.9.3' });
    if (path === '/deployment')
      return world.deployment === 'down' ? down() : json(world.deployment ?? deployment());
    if (path === '/transport') {
      return world.transport === 'down'
        ? down()
        : json(world.transport ?? transport([queue('orders')]));
    }
    if (path === '/webhooks') {
      return world.routes === 'down'
        ? down()
        : json({ ok: true, data: { webhooks: world.routes ?? [route()] } });
    }
    if (path === '/webhooks/stats') return json({ ok: true, data: { stats: stats() } });
    return json({ error: 'unexpected request' }, 500);
  }) as typeof fetch;
  return seen;
}

const home = () => render(createElement(MemoryRouter, null, createElement(OverviewPro)));
const card = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid="home-card-${id}"]`);
const attention = (host: HTMLElement) => host.querySelector('[aria-label="Needs attention"]');

const AREAS: Record<string, string> = {
  queues: '/queues',
  jobs: '/jobs',
  dlq: '/dlq',
  workers: '/workers',
  cron: '/cron',
  gateway: '/events-gateway/metrics',
  delivery: '/transport',
  health: '/deployment',
  alerts: '/alerts',
};

describe('Home', () => {
  test('every area has a card, and each links to the page that has the detail', async () => {
    serveHome();
    const { host, unmount } = home();
    await settle(60);
    for (const [id, to] of Object.entries(AREAS)) {
      expect(card(host, id)?.getAttribute('href')).toBe(to);
    }
    expect(host.querySelector('h1')?.textContent).toContain('Home');
    expect(card(host, 'workers')?.textContent).toContain('3 of 4');
    expect(card(host, 'workers')?.textContent).toContain('1 gone quiet');
    expect(card(host, 'cron')?.textContent).toContain('3');
    expect(card(host, 'gateway')?.textContent).toContain('20.00%');
    unmount();
  });

  test('nothing needs attention says so, once every source has answered', async () => {
    serveHome({ deployment: deployment({ workers: { total: 3, active: 3 } }) });
    const { host, unmount } = home();
    await settle(60);
    expect(attention(host)?.textContent).toContain('Nothing needs attention.');
    expect(attention(host)?.querySelector('li')).toBeNull();
    unmount();
  });

  test('open problems are listed worst first, each a link', async () => {
    serveHome({
      dlq: 2,
      paused: true,
      deployment: deployment({
        warnings: [{ code: 'schema', severity: 'critical', message: 'The schema is behind.' }],
      }),
      routes: [route({ enabled: false, disabledReason: '10 failures in a row' })],
    });
    useAlertRuntimeStore.setState({
      breaching: [
        {
          ruleId: 'r',
          ruleName: 'Backlog high',
          metricLabel: 'Waiting',
          operator: '>',
          threshold: 1,
          value: 5,
          queue: 'orders',
          at: 1,
        },
      ],
    });
    const { host, unmount } = home();
    await settle(60);
    const rows = [...(attention(host)?.querySelectorAll('li') ?? [])];
    expect(rows.map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual([
      '/deployment',
      '/alerts',
      '/dlq',
      '/events-gateway/issues',
      '/workers',
      '/queues',
    ]);
    expect(rows[0]?.textContent).toContain('The schema is behind.');
    expect(rows[1]?.textContent).toContain('1 alert is firing');
    unmount();
  });

  test('a closed capability leaves its card out and its call unmade', async () => {
    const closed: Capabilities = {
      ...DEMO_CAPABILITIES,
      features: { ...DEMO_CAPABILITIES.features, dlq: false, cron: false, webhooks: false },
    };
    useCapabilitiesStore.setState({ status: 'ready', caps: closed, error: null, key: 'test' });
    const seen = serveHome();
    const { host, unmount } = home();
    await settle(60);
    for (const id of ['dlq', 'cron', 'gateway']) expect(card(host, id)).toBeNull();
    for (const id of ['queues', 'jobs', 'workers', 'delivery', 'health', 'alerts']) {
      expect(card(host, id)).not.toBeNull();
    }
    expect(seen.some((path) => path.startsWith('/webhooks'))).toBe(false);
    unmount();
  });

  test('a failing call leaves only its own cards unavailable', async () => {
    serveHome({ deployment: 'down', routes: 'down' });
    const { host, unmount } = home();
    await settle(60);
    for (const id of ['workers', 'health', 'gateway']) {
      expect(card(host, id)?.textContent).toContain('Unavailable');
    }
    expect(card(host, 'queues')?.textContent).not.toContain('Unavailable');
    expect(card(host, 'delivery')?.textContent).not.toContain('Unavailable');
    expect(attention(host)?.textContent).toContain(
      'Could not be read: Health, Workers, Event gateway.'
    );
    expect(attention(host)?.textContent).toContain(
      'Nothing needs attention in what could be read.'
    );
    unmount();
  });
});
