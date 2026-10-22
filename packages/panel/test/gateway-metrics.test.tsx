import { Issues } from '../src/pages/control/gateway/Issues';
import { Metrics } from '../src/pages/control/gateway/Metrics';
import { at, route, serveGateway, stats } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const METRICS = '/events-gateway/metrics';
const ISSUES = '/events-gateway/issues';
const link = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('a')].find((a) => a.textContent === text);

describe('Metrics screen', () => {
  test('shows the outcomes, the rate, the backlog and how fast receivers answer', async () => {
    serveGateway([route()], [], stats());
    const view = at(METRICS, createElement(Metrics));
    await settle(20);
    const text = view.host.textContent ?? '';
    for (const label of [
      'Successful',
      'Failed',
      'Failure rate',
      'Attempts per event',
      'Waiting now',
      'Receiver speed (p95)',
      'Events over time',
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain('20.00%');
    view.unmount();
  });

  test('asks for the connection and window in the address, and links to the events behind the numbers', async () => {
    const week = 7 * 3_600_000;
    const calls = serveGateway(
      [route()],
      [],
      stats({ bucketMs: week, buckets: stats().buckets.map((b, n) => ({ ...b, from: n * week })) })
    );
    const view = at(`${METRICS}?route=hook-1&range=7d`, createElement(Metrics));
    await settle(20);
    const read = new URL(
      calls.seen.find((c) => c.includes('/webhooks/stats'))!.split(' ')[1]!,
      'http://x'
    );
    expect(read.searchParams.get('webhook')).toBe('hook-1');
    expect(Number(read.searchParams.get('until')) - Number(read.searchParams.get('since'))).toBe(
      7 * 86_400_000
    );
    expect(link(view.host, 'View failed events')?.getAttribute('href')).toBe(
      '/events-gateway/events?route=hook-1&range=7d&status=failed'
    );
    expect(link(view.host, 'View all events')?.getAttribute('href')).toBe(
      '/events-gateway/events?route=hook-1&range=7d'
    );
    view.unmount();
  });

  test('a window with no events, and a server that cannot answer, are each said in words', async () => {
    serveGateway(
      [route()],
      [],
      stats({
        delivered: 0,
        failed: 0,
        pending: 0,
        failureRatio: null,
        avgAttempts: null,
        latency: null,
        backlog: 0,
        oldestPendingAt: null,
      })
    );
    const empty = at(METRICS, createElement(Metrics));
    await settle(20);
    expect(empty.host.textContent).toContain('No events in this window');
    empty.unmount();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('{"ok":false,"error":"down"}', { status: 500 })
      )) as typeof fetch;
    const failed = at(METRICS, createElement(Metrics));
    await settle(20);
    expect(failed.host.textContent).toContain('Something went wrong');
    failed.unmount();
  });
});

describe('Issues screen', () => {
  test('lists a paused connection first, then a failing one, and not a healthy one', async () => {
    serveGateway([
      route({ id: 'ok', url: 'https://receiver.test/ok' }),
      route({
        id: 'slow',
        url: 'https://receiver.test/slow',
        consecutiveFailures: 7,
        alertLevel: 2,
      }),
      route({
        id: 'hook-1',
        enabled: false,
        consecutiveFailures: 10,
        alertLevel: 4,
        disabledReason: 'too many failures',
        disabledAt: Date.now() - 60_000,
      }),
    ]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    const items = [...view.host.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('https://receiver.test/hook');
    expect(items[1]).toContain('7 events failed in a row');
    expect(items[1]).toContain('70% of the way to being paused.');
    expect(view.host.textContent).not.toContain('receiver.test/ok');
    expect(link(view.host, 'View failed events')?.getAttribute('href')).toBe(
      '/events-gateway/events?route=hook-1&status=failed'
    );
    view.unmount();
  });

  test('Turn back on switches a paused connection on', async () => {
    const calls = serveGateway([
      route({
        enabled: false,
        consecutiveFailures: 10,
        alertLevel: 4,
        disabledReason: 'x',
        disabledAt: 1,
      }),
    ]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    act(() => buttonByText(view.host, 'Turn back on').click());
    await settle(20);
    expect(calls.seen).toContain('PUT /webhooks/hook-1/enabled');
    expect(calls.bodies).toEqual([{ enabled: true }]);
    view.unmount();
  });

  test('with nothing wrong it says so', async () => {
    serveGateway([route()]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    expect(view.host.textContent).toContain('No issues');
    view.unmount();
  });
});
