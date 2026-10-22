import { Connections } from '../src/pages/control/gateway/Connections';
import { at, groupStat, route, serveGateway } from './gateway.helpers';
import {
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const HOME = '/events-gateway';
const headers = (host: HTMLElement) =>
  [...host.querySelectorAll('th')].map((th) => th.textContent?.trim());

describe('Connections: the last 24 hours and the name', () => {
  test('one grouped read gives every row its numbers, not one read per row', async () => {
    const calls = serveGateway(
      [route({ id: 'a' }), route({ id: 'b' }), route({ id: 'c' })],
      [],
      undefined,
      [groupStat({ webhookId: 'a' }), groupStat({ webhookId: 'b', failed: 0, failureRatio: 0 })]
    );
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const grouped = calls.seen.filter((line) => line.includes('/webhooks/stats'));
    expect(grouped).toHaveLength(1);
    const query = new URL(`http://x${grouped[0]!.split(' ')[1]}`).searchParams;
    expect(query.get('groupBy')).toBe('webhook');
    expect(query.get('buckets')).toBe('24');
    expect(Number(query.get('until')) - Number(query.get('since'))).toBe(24 * 3_600_000);
    // The diagram says it in words under each connection: no column, no image to describe.
    expect(headers(view.host)).toEqual([]);
    const figures = [...view.host.querySelectorAll('li')].map((li) => li.textContent ?? '');
    for (const [i, failed] of [
      [0, '2'],
      [1, '0'],
    ] as const) {
      expect(figures[i]).toContain('8 successful');
      expect(figures[i]).toContain(`${failed} failed`);
      expect(figures[i]).toContain('1 waiting now');
      expect(figures[i]).toContain('in the last 24 hours');
    }
    expect(figures[2]).toContain('No events');
    view.unmount();

    // The Table view keeps its column, with one description of the bars and the share that failed.
    serveGateway([route({ id: 'a' }), route({ id: 'b' }), route({ id: 'c' })], [], undefined, [
      groupStat({ webhookId: 'a' }),
      groupStat({ webhookId: 'b', failed: 0, failureRatio: 0 }),
    ]);
    const table = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    expect(headers(table.host)).toContain('Last 24 hours');
    const labels = [
      ...table.host.querySelectorAll('[role="img"][aria-label*="last 24 hours"]'),
    ].map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      '8 successful, 2 failed, 1 waiting now in the last 24 hours',
      '8 successful, 0 failed, 1 waiting now in the last 24 hours',
    ]);
    expect(table.host.textContent).toContain('20% failed');
    expect(table.host.textContent).toContain('No events');
    table.unmount();
  });

  test('a server that cannot group leaves the numbers out and the list still works', async () => {
    serveGateway([route({ id: 'a' }), route({ id: 'b', url: 'https://receiver.test/b' })]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    // Without the grouped read each row shows its lifetime totals and says so.
    expect(view.host.querySelectorAll('li')).toHaveLength(2);
    expect(view.host.textContent).toContain('in total');
    expect(view.host.textContent).not.toContain('in the last 24 hours');
    expect(view.host.textContent).not.toContain('Could not');
    view.unmount();
  });

  test('the Table view has the column too', async () => {
    serveGateway([route()], [], undefined, [groupStat()]);
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    expect(headers(view.host)).toContain('Last 24 hours');
    view.unmount();
  });

  test('a connection with a name shows it first, with where it sends beneath, and is found by it', async () => {
    serveGateway([
      route({ id: 'a', name: 'Orders to billing' }),
      route({ id: 'b', url: 'https://receiver.test/other' }),
    ]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const pills = [...view.host.querySelectorAll('li a[href^="/events-gateway/connections/"]')];
    const names = pills.map((a) => a.getAttribute('aria-label'));
    expect(names[0]).toContain('Orders to billing');
    expect(names[1]).toContain('receiver.test');
    expect(view.host.textContent).toContain('receiver.test');
    view.unmount();

    serveGateway([
      route({ id: 'a', name: 'Orders to billing' }),
      route({ id: 'b', url: 'https://receiver.test/other' }),
    ]);
    const filtered = at(`${HOME}?q=billing`, createElement(Connections));
    await settle(20);
    expect(filtered.host.querySelectorAll('li')).toHaveLength(1);
    filtered.unmount();
  });

  test('delay and dedupe show as rules in the Table view', async () => {
    serveGateway([route({ delayMs: 5_000, dedupe: { windowMs: 60_000, fields: ['event'] } })]);
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    expect(view.host.textContent).toContain('Delay');
    expect(view.host.textContent).toContain('Deduplicated');
    view.unmount();
  });
});
