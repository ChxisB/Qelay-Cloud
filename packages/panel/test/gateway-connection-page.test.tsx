import { Route, Routes } from 'react-router-dom';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { Connections } from '../src/pages/control/gateway/Connections';
import { asViewer, at, route, serveGateway, stats } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  settle,
  test,
  useToastStore,
} from './server-action-pages.helpers';

installTestHooks();

const BASE = '/events-gateway/connections';
/** The three paths App.tsx serves, each with its tab. */
const page = (path: string) =>
  at(
    path,
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: `${BASE}/:id`,
        element: createElement(ConnectionPage, { tab: 'overview' }),
      }),
      createElement(Route, {
        path: `${BASE}/:id/metrics`,
        element: createElement(ConnectionPage, { tab: 'metrics' }),
      })
    )
  );
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);
const link = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('a')].find((a) => a.textContent === text);

describe('Connection page', () => {
  test('a connection in the list opens its page', async () => {
    serveGateway([route()]);
    const view = at('/events-gateway', createElement(Connections));
    await settle(20);
    const opens = view.host.querySelector(`a[href="${BASE}/hook-1"]`);
    expect(opens?.textContent).toContain('receiver.test');
    view.unmount();
  });

  test('the overview says what the connection is and how it is doing, and goes back to the list', async () => {
    serveGateway([route({ id: 'hook-1', successCount: 7, failureCount: 3 })]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    const text = view.host.textContent ?? '';
    for (const word of ['Active', 'Source: src_1', 'receiver.test', 'Signed', 'hook-1']) {
      expect(text).toContain(word);
    }
    // The numbers are this connection's own 24 hours.
    expect(text).toContain('Failure rate');
    expect(link(view.host, 'Connections')?.getAttribute('href')).toBe('/events-gateway');
    view.unmount();
  });

  test('the overview asks the stats read for this connection only', async () => {
    const calls = serveGateway([route()]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    const read = calls.seen.find((c) => c.includes('/webhooks/stats'))!;
    expect(new URL(read.split(' ')[1]!, 'http://x').searchParams.get('webhook')).toBe('hook-1');
    view.unmount();
  });

  test('Pause holds the connection at once and Resume turns it back on', async () => {
    const calls = serveGateway([route()]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    act(() => buttonByText(view.host, 'Pause connection').click());
    expect(hasButton(view.host, 'Resume connection')).toBe(true);
    expect(view.host.textContent).toContain('Paused');
    expect(view.host.textContent).not.toContain('Disabled');
    await settle(20);
    expect(calls.seen).toContain('PUT /webhooks/hook-1/enabled');
    expect(calls.bodies).toContainEqual({ enabled: false, mode: 'hold' });
    view.unmount();

    const off = serveGateway([
      route({ enabled: false, pausedBy: 'operator', disabledReason: 'paused by an operator' }),
    ]);
    const again = page(`${BASE}/hook-1`);
    await settle(20);
    act(() => buttonByText(again.host, 'Resume connection').click());
    await settle(20);
    expect(off.bodies).toContainEqual({ enabled: true });
    again.unmount();
  });

  test('a pause the server refuses says so and the page returns to what the server has', async () => {
    serveGateway([route()]);
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Promise.resolve(json({ ok: false, error: 'the registry is read-only' }, 500))
        : served(input, init)) as typeof fetch;
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    act(() => buttonByText(view.host, 'Pause connection').click());
    await settle(40);
    expect(hasButton(view.host, 'Pause connection')).toBe(true);
    expect(useToastStore.getState().toasts.map((toast) => toast.detail)).toContain(
      'the registry is read-only'
    );
    view.unmount();
  });

  test('a paused-after-failures connection offers Resume and says why it stopped', async () => {
    serveGateway([route({ enabled: false, disabledReason: 'failed 20 times in a row' })]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    expect(hasButton(view.host, 'Resume connection')).toBe(true);
    expect(view.host.textContent).toContain('Paused after failures');
    expect(view.host.textContent).toContain('failed 20 times in a row');
    view.unmount();
  });

  test('Send test event queues one, and View events opens the feed for this connection', async () => {
    const calls = serveGateway([route()]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    act(() => buttonByText(view.host, 'Send test event').click());
    await settle(20);
    expect(calls.seen).toContain('POST /webhooks/hook-1/test');
    expect(link(view.host, 'View events')?.getAttribute('href')).toBe(
      '/events-gateway/events?route=hook-1'
    );
    view.unmount();
  });

  test('an id that is not in the registry says so, with a way back', async () => {
    serveGateway([route()]);
    const view = page(`${BASE}/gone`);
    await settle(20);
    expect(view.host.textContent).toContain('This connection no longer exists');
    expect(link(view.host, 'Back to connections')?.getAttribute('href')).toBe('/events-gateway');
    expect(hasButton(view.host, 'Pause connection')).toBe(false);
    view.unmount();
  });

  test('a disabled connection offers Enable, and a viewer is offered no action', async () => {
    serveGateway([route({ enabled: false })]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    expect(hasButton(view.host, 'Enable connection')).toBe(true);
    expect(view.host.textContent).toContain('Disabled');
    view.unmount();

    asViewer();
    const read = page(`${BASE}/hook-1`);
    await settle(20);
    expect(read.host.textContent).toContain('Disabled');
    expect(hasButton(read.host, 'Enable connection')).toBe(false);
    expect(hasButton(read.host, 'Send test event')).toBe(false);
    read.unmount();
  });

  test('the Metrics tab reads this connection, has a time range and no connection select', async () => {
    const week = 7 * 3_600_000;
    const calls = serveGateway(
      [route()],
      [],
      stats({ bucketMs: week, buckets: stats().buckets.map((b, n) => ({ ...b, from: n * week })) })
    );
    const view = page(`${BASE}/hook-1/metrics?range=7d`);
    await settle(20);
    const read = calls.seen.find((c) => c.includes('/webhooks/stats'))!;
    const query = new URL(read.split(' ')[1]!, 'http://x').searchParams;
    expect(query.get('webhook')).toBe('hook-1');
    expect(Number(query.get('until')) - Number(query.get('since'))).toBe(7 * 86_400_000);
    expect(view.host.querySelector('select[aria-label="Time range"]')).not.toBeNull();
    expect(view.host.querySelector('select[aria-label="Connection"]')).toBeNull();
    expect(view.host.textContent).toContain('Receiver speed');
    view.unmount();
  });

  test('the tab bar marks the open tab and links to the other', async () => {
    serveGateway([route()]);
    const view = page(`${BASE}/hook-1`);
    await settle(20);
    const tabs = view.host.querySelector('nav[aria-label="This connection"]')!;
    expect(tabs.querySelector('a[aria-current="page"]')?.textContent).toBe('Overview');
    expect(tabs.querySelector(`a[href="${BASE}/hook-1/metrics"]`)?.textContent).toBe('Metrics');
    view.unmount();
  });
});
