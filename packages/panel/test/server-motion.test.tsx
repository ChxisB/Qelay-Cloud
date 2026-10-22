import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ProcessLogs } from '../src/pages/control/server/ProcessLogs';
import { ServerControl } from '../src/pages/control/ServerControl';
import { click, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// System, the Server tab: the halo goes out once when the server turns healthy, a reading washes only when a poll
// changes it (the uptime never does), and new log lines slide in only when a later poll brings them. happy-dom plays
// no animation, so these check which elements carry the motion classes and whether an element is the same one.

const realFetch = globalThis.fetch;
const config = {
  command: 'qelay start',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: './data/a.db',
  extraEnv: {},
};
const up = {
  managementMode: 'managed',
  status: 'running',
  generation: 1,
  configRevision: 1,
  pid: 4242,
  startedAt: Date.now() - 90_000,
  exitCode: null,
  healthy: true,
  reachable: true,
  config,
  runningConfig: config,
  db: null,
};
const down = { ...up, status: 'stopped', pid: null, startedAt: null, healthy: false };

interface World {
  status: typeof up;
  rss: number;
  tcp: number;
  lines: Array<{ seq: number; ts: number; stream: 'stdout' | 'stderr' | 'sys'; line: string }>;
}
let world: World;
let views: Array<{ unmount: () => void }>;

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 20,
  });
  world = { status: up, rss: 128, tcp: 3, lines: [] };
  views = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/control/status') return Response.json(world.status);
    if (path === '/control/logs') return Response.json({ lines: world.lines });
    if (path === '/health') {
      return Response.json({
        ok: true,
        memory: { rss: world.rss, heapUsed: 40, heapTotal: 64 },
        connections: { tcp: world.tcp, ws: 1, sse: 1 },
      });
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const view of views) view.unmount();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

function mount(element: ReturnType<typeof createElement>) {
  const view = renderUi(createElement(MemoryRouter, null, element));
  views.push(view);
  return view.host;
}

const bar = (host: HTMLElement) => host.querySelector('section[aria-label="Server status"]')!;
const fact = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('.eyebrow')].find((el) => el.textContent === label)!.parentElement!;

describe('the status bar', () => {
  test('a server that is already healthy when the page opens sends no halo', async () => {
    const host = mount(createElement(ServerControl));
    await settle(80);
    expect(bar(host).textContent).toContain('Healthy');
    expect(bar(host).querySelector('.motion-ping')).toBeNull();
  });

  test('the halo goes out once when the server turns healthy, and polls that change nothing leave it alone', async () => {
    world.status = down;
    const host = mount(createElement(ServerControl));
    await settle(80);
    expect(bar(host).querySelector('.motion-ping')).toBeNull();

    world.status = up;
    await settle(80);
    const halo = bar(host).querySelector('.motion-ping');
    expect(halo).not.toBeNull();
    await settle(120);
    expect(bar(host).querySelector('.motion-ping')).toBe(halo);

    world.status = down;
    await settle(80);
    expect(bar(host).querySelector('.motion-ping')).toBeNull();
  });

  test('memory and connections wash only when a poll changes them, and the uptime never does', async () => {
    const host = mount(createElement(ServerControl));
    await settle(80);
    expect(bar(host).querySelectorAll('.motion-flash')).toHaveLength(0);

    world.rss = 130;
    await settle(80);
    expect([...bar(host).querySelectorAll('.motion-flash')].map((el) => el.textContent)).toEqual([
      '130 MB',
    ]);
    expect(fact(host, 'Memory').querySelector('.motion-flash')).not.toBeNull();
    expect(fact(host, 'Connections').querySelector('.motion-flash')).toBeNull();

    world.tcp = 4;
    await settle(80);
    expect(fact(host, 'Connections').querySelector('.motion-flash')?.textContent).toBe('6');
  });
});

describe('the log tail', () => {
  const line = (seq: number, stream: 'stdout' | 'stderr' = 'stdout') => ({
    seq,
    ts: 1_700_000_000_000 + seq,
    stream,
    line: `line ${seq}`,
  });
  const arriving = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.motion-arrive')];

  test('lines that are there when the page opens do not slide; lines a later poll brings do, in order', async () => {
    world.lines = [line(1), line(2), line(3)];
    const host = mount(createElement(ProcessLogs));
    await settle(80);
    expect(host.textContent).toContain('line 3');
    expect(arriving(host)).toHaveLength(0);

    world.lines = [...world.lines, line(4), line(5)];
    await settle(80);
    expect(arriving(host).map((el) => el.textContent)).toEqual(['line 4', 'line 5']);
    expect(arriving(host).map((el) => el.style.getPropertyValue('--i'))).toEqual(['0', '1']);
  });

  test('a burst slides in only its last eight lines', async () => {
    world.lines = [line(1)];
    const host = mount(createElement(ProcessLogs));
    await settle(80);

    world.lines = [line(1), ...Array.from({ length: 12 }, (_, i) => line(i + 2))];
    await settle(80);
    expect(arriving(host).map((el) => el.textContent)).toEqual(
      Array.from({ length: 8 }, (_, i) => `line ${i + 6}`)
    );
  });

  test('Times does not make an old line slide, and a quiet poll leaves the arrived ones as they were', async () => {
    world.lines = [line(1), line(2)];
    const host = mount(createElement(ProcessLogs));
    await settle(80);
    world.lines = [...world.lines, line(3)];
    await settle(80);
    const [third] = arriving(host);
    expect(third?.textContent).toBe('line 3');

    const times = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Times')!;
    click(times);
    await settle(80);
    expect(arriving(host).map((el) => el.textContent)).toHaveLength(1);
    expect(arriving(host)[0]?.textContent).toContain('line 3');
    expect(arriving(host)[0]).toBe(third!);
  });
});
