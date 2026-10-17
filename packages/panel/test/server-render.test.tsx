import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { diskHealthOf } from '../src/pages/control/server/diskHealth';
import { ServerControl } from '../src/pages/control/ServerControl';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const CONFIG = {
  command: 'bunx qelay@2.9.11 start',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: 'data/qelay.db',
  extraEnv: {},
};

const DB = {
  path: 'data/qelay.db',
  exists: true,
  size: 40_000_000,
  walSize: 1_000_000,
  shmSize: 32_768,
  totalSize: 41_032_768,
  mtimeMs: Date.now() - 5_000,
};

const RUNNING = {
  managementMode: 'managed',
  status: 'running',
  pid: 4242,
  startedAt: Date.now() - 90_000,
  exitCode: null,
  healthy: true,
  reachable: true,
  version: '2.9.4',
  storageMode: 'sqlite',
  config: CONFIG,
  runningConfig: CONFIG,
  configRevision: 1,
  db: DB,
};

const STOPPED = { ...RUNNING, status: 'stopped', pid: null, startedAt: null, healthy: false };

const EXTERNAL = {
  managementMode: 'external',
  status: 'stopped',
  pid: null,
  startedAt: null,
  exitCode: null,
  healthy: true,
  reachable: true,
  version: '2.9.4',
  externalUrl: 'http://queue.test:6790',
  healthStatus: 200,
  config: CONFIG,
  db: null,
};

const VITALS = {
  ok: true,
  memory: { rss: 128, heapUsed: 40, heapTotal: 64 },
  connections: { tcp: 3, ws: 1, sse: 1 },
};

interface World {
  status: unknown;
  /** `/storage` body, or null to make the call fail. */
  storage: unknown;
  agentDown?: boolean;
}

/** Answers the agent's status/logs and the server's health/storage from `world`. */
function serve(world: World) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
    if (url.includes('/control/status')) {
      return world.agentDown ? Promise.reject(new Error('agent down')) : json(world.status);
    }
    if (url.includes('/control/logs')) return json({ lines: [] });
    if (url.endsWith('/health')) return json(VITALS);
    if (url.endsWith('/storage')) {
      return world.storage ? json(world.storage) : json({ error: 'no storage' }, 500);
    }
    return json({ error: 'unexpected request' }, 500);
  }) as typeof fetch;
}

function renderServer() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, null, createElement(ServerControl))));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().endsWith(text));

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

describe('Server page — running and healthy', () => {
  test('shows the status bar with its facts, and carries the screen’s only brand gradient', async () => {
    serve({ status: RUNNING, storage: { ok: true, data: { diskFull: false } } });
    const { host, unmount } = renderServer();
    await settle(80);

    const bar = host.querySelector('section[aria-label="Server status"]');
    expect(bar?.textContent).toContain('Running');
    expect(bar?.textContent).toContain('Healthy');
    expect(bar?.textContent).toContain('v2.9.4');
    expect(bar?.textContent).toContain('4242');
    expect(bar?.textContent).toContain('128 MB');
    expect(bar?.textContent).toContain('bunx qelay@2.9.11 start');
    expect(bar?.textContent).toContain('6790 http · 6789 tcp');
    expect(host.querySelectorAll('[class*="linear-gradient"]').length).toBe(1);

    expect(button(host, 'Start')?.disabled).toBe(true);
    expect(button(host, 'Stop')?.disabled).toBe(false);
    expect(button(host, 'Restart')?.disabled).toBe(false);
    unmount();
  });

  test('connections show the total, with the breakdown on hover', async () => {
    serve({ status: RUNNING, storage: null });
    const { host, unmount } = renderServer();
    await settle(80);

    const fact = [...host.querySelectorAll('[title]')].find(
      (el) => el.getAttribute('title') === '3 tcp · 1 ws · 1 sse'
    );
    expect(fact?.textContent).toBe('5');
    unmount();
  });

  test('says the disk is healthy only when /storage says so', async () => {
    serve({ status: RUNNING, storage: { ok: true, data: { diskFull: false } } });
    const healthy = renderServer();
    await settle(80);
    expect(healthy.host.textContent).toContain('Disk healthy · no write errors');
    healthy.unmount();

    serve({ status: RUNNING, storage: null });
    const unknown = renderServer();
    await settle(80);
    expect(unknown.host.textContent).toContain('Storage');
    expect(unknown.host.textContent).not.toContain('Disk healthy');
    expect(unknown.host.querySelector('[role="alert"]')).toBeNull();
    unknown.unmount();

    serve({
      status: RUNNING,
      storage: { ok: true, data: { diskFull: true, error: 'ENOSPC: no space left' } },
    });
    const full = renderServer();
    await settle(80);
    expect(full.host.querySelector('[role="alert"]')?.textContent).toContain(
      'Disk full · ENOSPC: no space left'
    );
    expect(full.host.textContent).not.toContain('Disk healthy');
    full.unmount();
  });
});

describe('Server page — configuration footer', () => {
  test('the one orange action is Save & restart while running, Save config while stopped', async () => {
    serve({ status: RUNNING, storage: null });
    const running = renderServer();
    await settle(80);
    expect(button(running.host, 'Save & restart')?.className).toContain('bg-primary');
    expect(button(running.host, 'Save config')?.className).not.toContain('bg-primary');
    running.unmount();

    serve({ status: STOPPED, storage: null });
    const stopped = renderServer();
    await settle(80);
    expect(button(stopped.host, 'Save & restart')).toBeUndefined();
    expect(button(stopped.host, 'Save config')?.className).toContain('bg-primary');
    stopped.unmount();
  });
});

describe('Server page — other states', () => {
  test('stopped: offers Start, disables Stop, and makes no claim about the disk', async () => {
    serve({ status: STOPPED, storage: { ok: true, data: { diskFull: false } } });
    const { host, unmount } = renderServer();
    await settle(80);

    const bar = host.querySelector('section[aria-label="Server status"]');
    expect(bar?.textContent).toContain('Stopped');
    expect(bar?.textContent).toContain('The server is not running');
    expect(button(host, 'Start')?.disabled).toBe(false);
    expect(button(host, 'Stop')?.disabled).toBe(true);
    expect(host.textContent).not.toContain('Disk healthy');
    unmount();
  });

  test('crashed: names the exit code', async () => {
    serve({ status: { ...STOPPED, exitCode: 137 }, storage: null });
    const { host, unmount } = renderServer();
    await settle(80);
    expect(host.textContent).toContain('Crashed · exit 137');
    unmount();
  });

  test('external: no lifecycle buttons, no launch command, and says who manages it', async () => {
    serve({ status: EXTERNAL, storage: null });
    const { host, unmount } = renderServer();
    await settle(80);

    const bar = host.querySelector('section[aria-label="Server status"]');
    expect(bar?.textContent).toContain('External');
    expect(bar?.textContent).toContain('healthy via http://queue.test:6790/health');
    expect(bar?.textContent).not.toContain('Launch command');
    expect(button(host, 'Start')).toBeUndefined();
    expect(button(host, 'Stop')).toBeUndefined();
    expect(host.textContent).toContain('Managed externally');
    expect(host.textContent).not.toContain('Process logs');
    unmount();
  });

  test('agent unreachable from the start: explains how to start it', async () => {
    serve({ status: null, storage: null, agentDown: true });
    const { host, unmount } = renderServer();
    await settle(80);
    expect(host.textContent).toContain('Control agent not running');
    expect(host.querySelector('section[aria-label="Server status"]')).toBeNull();
    unmount();
  });

  test('agent lost after loading: keeps the last state but marks it stale and locks Start/Stop', async () => {
    const world: World = { status: RUNNING, storage: null };
    serve(world);
    const { host, unmount } = renderServer();
    await settle(80);
    expect(host.textContent).toContain('Healthy');

    world.agentDown = true;
    await settle(120);
    expect(host.textContent).toContain('Agent unreachable');
    expect(host.textContent).toContain('Last known: pid 4242');
    expect(button(host, 'Stop')?.disabled).toBe(true);
    expect(button(host, 'Restart')?.disabled).toBe(true);
    unmount();
  });

  test('while the first status is pending, says so instead of claiming the server is stopped', () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    const { host, unmount } = renderServer();
    expect(host.textContent).toContain('Reaching the control agent');
    expect(host.textContent).not.toContain('Stopped');
    unmount();
  });
});

describe('diskHealthOf', () => {
  test('reads only a boolean diskFull; anything else is unknown', () => {
    expect(diskHealthOf({ ok: true, data: { diskFull: false } })).toEqual({ ok: true });
    expect(diskHealthOf({ data: { diskFull: true } })).toEqual({ ok: false, message: 'Disk full' });
    expect(diskHealthOf({ data: { diskFull: false, error: 'EIO' } })).toEqual({
      ok: false,
      message: 'Write error · EIO',
    });
    expect(diskHealthOf(null)).toBeNull();
    expect(diskHealthOf({})).toBeNull();
    expect(diskHealthOf({ data: { diskFull: 'no' } })).toBeNull();
    expect(diskHealthOf({ data: [] })).toBeNull();
  });
});
