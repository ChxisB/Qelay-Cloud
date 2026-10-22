import { Connections } from '../src/pages/control/gateway/Connections';
import { answer, asking, at, menuItem, openMenu, route, serveGateway } from './gateway.helpers';
import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const HOME = '/events-gateway';
const NAME = 'https://receiver.test/hook';

describe('Connections screen', () => {
  test('groups connections under the source they listen to', async () => {
    serveGateway([
      route({ id: 'a' }),
      route({ id: 'b', url: 'https://receiver.test/other' }),
      route({ id: 'c', queue: null, url: 'https://receiver.test/all' }),
    ]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const sources = [...view.host.querySelectorAll('section[aria-label]')].map((el) =>
      el.getAttribute('aria-label')
    );
    expect(sources).toEqual(['Qelay jobs: emails', 'Qelay jobs: all queues']);
    // The page title is the h1, so a source is level 2: a level 3 straight after it skips a heading level.
    const headings = [...view.host.querySelectorAll('[role="heading"][aria-level="2"]')];
    expect(headings.map((h) => h.textContent)).toEqual([
      'Qelay jobs: emailsSource',
      'Qelay jobs: all queuesSource',
    ]);
    view.unmount();
  });

  test('says where each connection goes, and that a queue route goes to a queue', async () => {
    serveGateway([route({ destination: 'queue', url: '', target: 'refunds' })]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    expect(view.host.textContent).toContain('Queue: refunds');
    view.unmount();
  });

  test('with none, it says so and links to the page that makes one', async () => {
    serveGateway([]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    expect(view.host.textContent).toContain('No connections yet');
    expect(view.host.querySelector('input[name="webhook-url"]')).toBeNull();
    const links = [...view.host.querySelectorAll('a')].filter(
      (a) => a.textContent === 'New connection'
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      expect(link.getAttribute('href')).toBe('/events-gateway/connections/new');
    view.unmount();
  });

  test('with some, New connection is still one press away and no form is on the list', async () => {
    serveGateway([route()]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const link = [...view.host.querySelectorAll('a')].find(
      (a) => a.textContent === 'New connection'
    );
    expect(link?.getAttribute('href')).toBe('/events-gateway/connections/new');
    expect(view.host.querySelector('input[name="webhook-url"]')).toBeNull();
    view.unmount();
  });

  test('a test event is sent for a connection that is on, and refused in the UI for one that is off', async () => {
    const calls = serveGateway([route()]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const send = menuItem(openMenu(view.host, NAME), 'Send a test event');
    act(() => send.click());
    await settle(20);
    expect(calls.seen).toContain('POST /webhooks/hook-1/test');
    view.unmount();

    const none = serveGateway([route({ enabled: false })]);
    const off = at(HOME, createElement(Connections));
    await settle(20);
    const item = menuItem(openMenu(off.host, NAME), 'Send a test event');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    act(() => item.click());
    await settle(20);
    expect(none.seen.some((call) => call.startsWith('POST'))).toBe(false);
    off.unmount();
  });

  test('turning a connection off and removing it each go to the server once', async () => {
    const calls = serveGateway([route()]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    act(() =>
      view.host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Turn off connection to https://receiver.test/hook"]'
        )!
        .click()
    );
    await settle(20);
    expect(calls.seen.filter((call) => call.startsWith('PUT'))).toEqual([
      'PUT /webhooks/hook-1/enabled',
    ]);
    expect(calls.bodies).toEqual([{ enabled: false }]);
    const remove = menuItem(openMenu(view.host, NAME), 'Remove connection');
    act(() => remove.click());
    await settle(5);
    // It asks in the page first, and nothing is sent until the main button answers.
    expect(asking()?.question).toBe('Remove the connection to https://receiver.test/hook?');
    expect(calls.seen).not.toContain('DELETE /webhooks/hook-1');
    answer(true);
    await settle(20);
    expect(calls.seen).toContain('DELETE /webhooks/hook-1');
    view.unmount();
  });
});

describe('signing secret', () => {
  test('the list never shows a secret: only whether deliveries are signed', async () => {
    serveGateway([route({ signed: false, urlRedacted: true, url: 'https://receiver.test/' })]);
    const view = at(HOME, createElement(Connections));
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('unsigned');
    expect(text).toContain('path hidden');
    view.unmount();
  });
});
