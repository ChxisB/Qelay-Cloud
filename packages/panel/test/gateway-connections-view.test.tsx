import { Connections } from '../src/pages/control/gateway/Connections';
import { answer, at, route, serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  setInput,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const HOME = '/events-gateway';
const routes = () => [
  route({ id: 'a', filter: { 'body.kind': 'invoice' }, shape: { id: 'x' } }),
  route({ id: 'b', destination: 'queue', url: '', target: 'refunds', source: 'orders-hook' }),
  route({ id: 'c', enabled: false, disabledReason: 'failing', url: 'https://other.test/x' }),
];
const rows = (host: HTMLElement) => host.querySelectorAll('tbody tr').length;
const sources = (host: HTMLElement) => host.querySelectorAll('section[aria-label]').length;
const search = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('input[aria-label="Search connections"]')!;
const pick = (host: HTMLElement, label: string, value: string) =>
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });

describe('Connections view', () => {
  test('the table view is one flat table with a row per connection and its rule chips', async () => {
    serveGateway(routes());
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    expect(view.host.querySelectorAll('table')).toHaveLength(1);
    expect(sources(view.host)).toBe(0);
    expect(rows(view.host)).toBe(3);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Filter');
    expect(text).toContain('Reshaped');
    expect(text).toContain('Queue: refunds');
    view.unmount();
  });

  test('the structured view stays the default, and a view it does not know falls back to it', async () => {
    serveGateway(routes());
    for (const path of [HOME, `${HOME}?view=bogus`]) {
      const view = at(path, createElement(Connections));
      await settle(20);
      expect(sources(view.host)).toBeGreaterThan(0);
      view.unmount();
    }
  });

  test('the switch moves between the two views', async () => {
    serveGateway(routes());
    const view = at(HOME, createElement(Connections));
    await settle(20);
    act(() => buttonByText(view.host, 'Table').click());
    await settle(5);
    expect(sources(view.host)).toBe(0);
    act(() => buttonByText(view.host, 'Structured').click());
    await settle(5);
    expect(sources(view.host)).toBeGreaterThan(0);
    view.unmount();
  });

  test('search narrows by destination and by source, and the address keeps it', async () => {
    serveGateway(routes());
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    setInput(search(view.host), 'refunds');
    await settle(5);
    expect(rows(view.host)).toBe(1);
    setInput(search(view.host), 'orders-hook');
    await settle(5);
    expect(rows(view.host)).toBe(1);
    view.unmount();

    const again = at(`${HOME}?view=table&q=other.test`, createElement(Connections));
    await settle(20);
    expect(rows(again.host)).toBe(1);
    expect(search(again.host).value).toBe('other.test');
    again.unmount();
  });

  test('the state select narrows to active, paused or off', async () => {
    serveGateway(routes());
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    pick(view.host, 'State', 'paused');
    await settle(5);
    expect(rows(view.host)).toBe(1);
    expect(view.host.textContent).toContain('other.test');
    pick(view.host, 'State', 'active');
    await settle(5);
    expect(rows(view.host)).toBe(2);
    view.unmount();
  });

  test('a filter that matches nothing says so, and Clear filters brings everything back', async () => {
    serveGateway(routes());
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    setInput(search(view.host), 'zzz');
    await settle(5);
    expect(view.host.textContent).toContain('No connection matches');
    expect(rows(view.host)).toBe(0);
    act(() => buttonByText(view.host, 'Clear filters').click());
    await settle(5);
    expect(rows(view.host)).toBe(3);
    view.unmount();
  });

  test('turn off, test and remove all work from the table', async () => {
    const calls = serveGateway([route()]);
    const view = at(`${HOME}?view=table`, createElement(Connections));
    await settle(20);
    act(() => buttonByText(view.host, 'Test').click());
    await settle(20);
    act(() =>
      view.host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Turn off connection to https://receiver.test/hook"]'
        )!
        .click()
    );
    await settle(20);
    act(() =>
      view.host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove connection to https://receiver.test/hook"]'
        )!
        .click()
    );
    await settle(5);
    answer(true);
    await settle(20);
    expect(calls.seen).toContain('POST /webhooks/hook-1/test');
    expect(calls.seen).toContain('PUT /webhooks/hook-1/enabled');
    expect(calls.seen).toContain('DELETE /webhooks/hook-1');
    view.unmount();
  });
});
