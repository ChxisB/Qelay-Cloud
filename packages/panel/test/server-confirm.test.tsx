import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, Fragment } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { ServerControl } from '../src/pages/control/ServerControl';
import { changeControl, click, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// Stop, Restart and Save & restart ask in the page's own dialog (the real ConfirmDialog is mounted here) and
// send the same call as before only on a yes. The configuration is checked before anything is asked.

const SHOWN = '[role="alertdialog"]';
const realFetch = globalThis.fetch;
const config = {
  command: 'qelay start',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: './data/a.db',
  extraEnv: {},
};
const running = {
  managementMode: 'managed',
  status: 'running',
  generation: 1,
  configRevision: 1,
  pid: 123,
  startedAt: Date.now() - 90_000,
  exitCode: null,
  healthy: true,
  reachable: true,
  config,
  runningConfig: config,
  db: null,
};
const vitals = {
  ok: true,
  memory: { rss: 128, heapUsed: 40, heapTotal: 64 },
  connections: { tcp: 3, ws: 1, sse: 1 },
};

let sent: string[];
let views: Array<{ unmount: () => void }>;

beforeEach(() => {
  ensureDom();
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
  sent = [];
  views = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const json = (body: unknown) => Promise.resolve(Response.json(body));
    if (path === '/control/status') return json(running);
    if (path === '/control/logs') return json({ lines: [] });
    if (path === '/health') return json(vitals);
    if (path === '/control/config') {
      sent.push('PUT /control/config');
      return json({ ...JSON.parse(String(init?.body)), configRevision: 2 });
    }
    if (path === '/control/stop' || path === '/control/restart') {
      sent.push(`POST ${path}`);
      return json(running);
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const view of views) view.unmount();
  globalThis.fetch = realFetch;
  useConfirmStore.setState({ current: null, queue: [] });
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

async function mount() {
  const view = renderUi(
    createElement(
      Fragment,
      null,
      createElement(MemoryRouter, null, createElement(ServerControl)),
      createElement(ConfirmDialog)
    )
  );
  views.push(view);
  await settle(40);
  return view.host;
}

const dialog = (host: HTMLElement) => host.querySelector<HTMLElement>(SHOWN);
const named = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const press = (scope: ParentNode, text: string) => {
  const found = named(scope, text);
  if (!found) throw new Error(`Missing button ${text}`);
  click(found);
};

describe('Stop and Restart', () => {
  test('Stop asks first, names the connections it drops, and sends nothing on Cancel', async () => {
    const host = await mount();
    press(host, 'Stop');
    await settle(10);
    expect(dialog(host)?.textContent).toContain('Stop the server?');
    expect(dialog(host)?.textContent).toContain('3 TCP / 1 WS connections');
    expect(sent).toEqual([]);

    press(dialog(host)!, 'Cancel');
    await settle(40);
    expect(sent).toEqual([]);

    press(host, 'Stop');
    await settle(10);
    press(dialog(host)!, 'Stop server');
    await settle(40);
    expect(sent).toEqual(['POST /control/stop']);
  });

  test('a double click on Restart asks once and restarts once', async () => {
    const host = await mount();
    const restart = named(host, 'Restart');
    if (!restart) throw new Error('Missing Restart');
    act(() => {
      restart.click();
      restart.click();
    });
    await settle(10);
    expect(host.querySelectorAll(SHOWN)).toHaveLength(1);
    expect(dialog(host)?.textContent).toContain('Restart the server?');

    press(dialog(host)!, 'Restart server');
    await settle(40);
    expect(sent).toEqual(['POST /control/restart']);
  });
});

describe('Save & restart', () => {
  const command = (host: HTMLElement) =>
    host.querySelector<HTMLInputElement>('[name="server-command"]')!;

  test('asks what changed, then saves and restarts on a yes', async () => {
    const host = await mount();
    changeControl(command(host), 'qelay start --new');
    press(host, 'Save & restart');
    await settle(10);
    expect(dialog(host)?.textContent).toContain('Save and restart the server?');
    expect(dialog(host)?.textContent).toContain('Changed: command.');
    expect(sent).toEqual([]);

    press(dialog(host)!, 'Save & restart');
    await settle(40);
    expect(sent).toEqual(['PUT /control/config', 'POST /control/restart']);
  });

  test('saves nothing when the answer is no', async () => {
    const host = await mount();
    changeControl(command(host), 'qelay start --new');
    press(host, 'Save & restart');
    await settle(10);
    press(dialog(host)!, 'Cancel');
    await settle(40);
    expect(sent).toEqual([]);
    expect(command(host).value).toBe('qelay start --new');
  });

  test('a draft that cannot be saved shows its error and asks nothing', async () => {
    const host = await mount();
    changeControl(host.querySelector<HTMLInputElement>('[name="server-tcp-port"]')!, '6790');
    press(host, 'Save & restart');
    await settle(10);
    expect(dialog(host)).toBeNull();
    expect(host.textContent).toContain('HTTP and TCP ports must differ');
    expect(sent).toEqual([]);
  });
});
