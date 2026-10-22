import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, Fragment } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Fleet } from '../src/pages/Fleet';
import { click, deferred, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// Stop and Restart node ask in the page's own dialog (the real ConfirmDialog is mounted here) and send the same
// call as before only on a yes. The cards also rise in once, on the first load, and "Refresh all" says it is busy.

const SHOWN = '[role="alertdialog"]';
const realFetch = globalThis.fetch;
const profile = (id: string, name: string) => ({
  id,
  name,
  baseUrl: `https://${id}.example/api`,
  agentBaseUrl: `https://${id}.example/agent`,
});
const running = {
  status: 'running',
  generation: 1,
  pid: 42,
  startedAt: 1,
  exitCode: null,
  healthy: true,
  storageMode: 'postgres',
  postgresNamespace: 'orders',
  postgresTarget: 'postgres.internal:5432/qelay',
  config: { command: 'qelay', httpPort: 6790, tcpPort: 6789, dataPath: '', extraEnv: {} },
};

let sent: string[];
let hold: ReturnType<typeof deferred<void>> | null;
let views: Array<{ unmount: () => void }>;

beforeEach(() => {
  ensureDom();
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  useConnectionStore.setState({
    profiles: [profile('a', 'Broker A'), profile('b', 'Broker B')],
    activeProfileId: 'a',
    baseUrl: 'https://a.example/api',
    agentBaseUrl: 'https://a.example/agent',
    token: '',
    agentToken: '',
  });
  sent = [];
  hold = null;
  views = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') sent.push(`${url.host}${url.pathname}`);
    if (url.pathname.endsWith('/health')) {
      await hold?.promise;
      return Response.json({ ok: true, status: 'healthy', uptime: 1, version: '2.9.3' });
    }
    return Response.json(running);
  }) as typeof fetch;
});

afterEach(() => {
  for (const view of views) view.unmount();
  globalThis.fetch = realFetch;
  useConfirmStore.setState({ current: null, queue: [] });
  useConnectionStore.setState({
    profiles: [
      {
        id: 'default',
        name: 'Local Qelay',
        baseUrl: '/api',
        agentBaseUrl: 'http://localhost:6800',
      },
    ],
    activeProfileId: 'default',
    baseUrl: '/api',
    agentBaseUrl: 'http://localhost:6800',
  });
});

async function mount() {
  const view = renderUi(
    createElement(
      Fragment,
      null,
      createElement(MemoryRouter, null, createElement(Fleet)),
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
const card = (host: HTMLElement, name: string) => {
  const heading = [...host.querySelectorAll('h2')].find((h) => h.textContent?.trim() === name);
  const found = heading?.closest<HTMLElement>('.rounded-card');
  if (!found) throw new Error(`Missing node card ${name}`);
  return found;
};

describe('Stop and Restart node', () => {
  test('Stop asks first, names the node, sends nothing on Cancel and the same call on a yes', async () => {
    const host = await mount();
    press(card(host, 'Broker A'), 'Stop');
    await settle(10);
    expect(dialog(host)?.textContent).toContain('Stop this node?');
    expect(dialog(host)?.textContent).toContain('Broker A');
    expect(sent).toEqual([]);

    press(dialog(host)!, 'Cancel');
    await settle(40);
    expect(sent).toEqual([]);

    press(card(host, 'Broker A'), 'Stop');
    await settle(10);
    press(dialog(host)!, 'Stop node');
    await settle(60);
    expect(sent).toEqual(['a.example/agent/control/stop']);
  });

  test('a second click while the question is open asks once and sends once', async () => {
    const host = await mount();
    const restart = named(card(host, 'Broker A'), 'Restart')!;
    click(restart);
    click(restart);
    await settle(10);
    expect(host.querySelectorAll(SHOWN)).toHaveLength(1);

    press(dialog(host)!, 'Restart node');
    await settle(60);
    expect(sent).toEqual(['a.example/agent/control/restart']);
  });

  test('a connection edited while the question is open ends the action', async () => {
    const host = await mount();
    press(card(host, 'Broker A'), 'Stop');
    await settle(10);
    act(() =>
      useConnectionStore.setState({
        profiles: [profile('a', 'Broker A'), profile('b', 'Renamed')],
      })
    );
    press(dialog(host)!, 'Stop node');
    await settle(60);
    expect(sent).toEqual([]);
  });
});

describe('Fleet motion', () => {
  test('the cards of the first load rise in turn and a node added later does not', async () => {
    const host = await mount();
    const first = card(host, 'Broker A');
    expect(first.className).toContain('motion-arrive');
    expect(first.style.getPropertyValue('--i')).toBe('0');
    expect(card(host, 'Broker B').style.getPropertyValue('--i')).toBe('1');

    act(() =>
      useConnectionStore.setState({
        profiles: [profile('a', 'Broker A'), profile('b', 'Broker B'), profile('c', 'Broker C')],
      })
    );
    await settle(60);
    expect(card(host, 'Broker C').className).not.toContain('motion-arrive');
  });

  test('the active node is a word as well as a border', async () => {
    const host = await mount();
    expect(card(host, 'Broker A').textContent).toContain('active');
    expect(named(card(host, 'Broker B'), 'Use node')).toBeDefined();
  });

  test('Refresh all is aria-disabled and says it is working until the poll settles, and ignores a second click', async () => {
    const host = await mount();
    hold = deferred<void>();
    const refresh = named(host, 'Refresh all')!;
    click(refresh);
    await settle(10);
    const busy = named(host, 'Refreshing…')!;
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    const probes = sent.length;
    click(busy);
    expect(sent.length).toBe(probes);

    hold.resolve();
    await settle(60);
    expect(named(host, 'Refresh all')?.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('Fleet loading', () => {
  test('says what it is doing in words, with a status that is busy, until the first poll lands', async () => {
    hold = deferred<void>();
    const view = renderUi(createElement(MemoryRouter, null, createElement(Fleet)));
    views.push(view);
    await settle(10);
    const status = view.host.querySelector('[role="status"][aria-busy="true"]');
    expect(status?.textContent).toContain('Checking every server node…');
    expect(view.host.querySelector('h2')).toBeNull();

    hold.resolve();
    await settle(60);
    expect(view.host.textContent).not.toContain('Checking every server node…');
  });
});
