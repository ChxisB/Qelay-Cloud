import { Route, Routes } from 'react-router-dom';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { CreateConnection } from '../src/pages/control/gateway/CreateConnection';
import { NEW_CONNECTION } from '../src/pages/control/gateway/model';
import { address, alertOf, answerAdd, field, page, posts, stepOf } from './gateway-create.helpers';
import { at, route, serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  setInput,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

describe('Create connection page', () => {
  test('/connections/new is the page, whichever order the routes are in, and never a connection called "new"', async () => {
    serveGateway([route()]);
    const view = at(
      NEW_CONNECTION,
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/events-gateway/connections/:id',
          element: createElement(ConnectionPage, { tab: 'overview' }),
        }),
        createElement(Route, {
          path: '/events-gateway/connections/new',
          element: createElement(CreateConnection),
        })
      )
    );
    await settle(20);
    expect(field(view.host, 'webhook-url')).not.toBeNull();
    expect(view.host.textContent).not.toContain('no longer exists');
    view.unmount();
  });

  test('walks through source, destination, rules and save, in that order', async () => {
    serveGateway([]);
    const view = page();
    await settle(10);
    expect([...view.host.querySelectorAll('ol > li h3')].map((h) => h.textContent)).toEqual([
      'Source',
      'Destination',
      'Rules',
      'Save',
    ]);
    expect(stepOf(field(view.host, 'webhook-queue'))).toBe('Source');
    expect(stepOf(field(view.host, 'webhook-url'))).toBe('Destination');
    expect(stepOf(field(view.host, 'webhook-secret'))).toBe('Rules');
    view.unmount();
  });

  test('Save opens the connection it made', async () => {
    serveGateway([]);
    answerAdd(json({ ok: true, data: { webhook: { id: 'new-1' } } }, 201));
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(address()).toBe('/events-gateway/connections/new-1');
    expect(view.host.textContent).toContain('landed on new-1');
    view.unmount();
  });

  test('an address connection with no secret sends the url and events only', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(calls.bodies).toEqual([
      { url: 'https://receiver.test/hook', events: ['job.completed', 'job.failed'] },
    ]);
    // The fixture answers without an id, so the list is the place to land.
    expect(address()).toBe('/events-gateway');
    view.unmount();
  });

  test('a reply that names no id lands on the list, not on a connection called "undefined"', async () => {
    serveGateway([]);
    answerAdd(json({ ok: true, id: 'ignored' }, 201));
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(address()).toBe('/events-gateway');
    view.unmount();
  });

  test('two presses in one tick send one connection', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    const add = buttonByText(view.host, 'Add connection');
    act(() => {
      add.click();
      add.click();
    });
    expect(posts(calls)).toHaveLength(1);
    await settle(20);
    view.unmount();
  });

  test('a connection to another queue is sent with its source and target', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    act(() => buttonByText(view.host, 'Another queue').click());
    setInput(field(view.host, 'webhook-queue'), 'orders');
    setInput(field(view.host, 'route-target'), 'refunds');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(calls.bodies).toEqual([
      {
        destination: 'queue',
        queue: 'orders',
        target: 'refunds',
        events: ['job.completed', 'job.failed'],
      },
    ]);
    view.unmount();
  });

  test('a queue route with no source or no target is refused before anything is sent', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    act(() => buttonByText(view.host, 'Another queue').click());
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(10);
    expect(alertOf(view.host)).not.toBeNull();
    expect(stepOf(alertOf(view.host))).toBe('Save');
    expect(posts(calls)).toEqual([]);
    expect(address()).toBe('/events-gateway/connections/new');
    view.unmount();
  });

  test('a loop is shown in the Destination step, and what was typed is kept', async () => {
    serveGateway([]);
    answerAdd(
      json(
        {
          ok: false,
          error: {
            code: 'route_cycle',
            message: 'the route would make a loop: a queue would end up adding jobs to itself',
          },
        },
        409
      )
    );
    const view = page();
    await settle(10);
    act(() => buttonByText(view.host, 'Another queue').click());
    setInput(field(view.host, 'webhook-queue'), 'orders');
    setInput(field(view.host, 'route-target'), 'orders');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(alertOf(view.host)?.textContent).toContain('loop');
    expect(stepOf(alertOf(view.host))).toBe('Destination');
    expect(field(view.host, 'webhook-queue').value).toBe('orders');
    expect(field(view.host, 'route-target').value).toBe('orders');
    expect(address()).toBe('/events-gateway/connections/new');
    // The refusal does not lock the form: a second try is sent.
    expect(buttonByText(view.host, 'Add connection').disabled).toBe(false);
    view.unmount();
  });

  test('a deployment with no signing key refuses a secret in the Rules step, and the secret is kept for another try', async () => {
    serveGateway([]);
    answerAdd(
      json(
        { ok: false, error: { code: 'webhook_key_missing', message: 'a signing secret needs it' } },
        409
      )
    );
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    setInput(field(view.host, 'webhook-secret'), 'sixteen-characters-long');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(stepOf(alertOf(view.host))).toBe('Rules');
    expect(field(view.host, 'webhook-secret').value).toBe('sixteen-characters-long');
    view.unmount();
  });

  test('a refusal that names no field is shown at Save', async () => {
    serveGateway([]);
    answerAdd(
      json(
        {
          ok: false,
          error: { code: 'webhook_limit', message: 'the namespace has the most webhooks it may' },
        },
        409
      )
    );
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(stepOf(alertOf(view.host))).toBe('Save');
    expect(alertOf(view.host)?.textContent).toContain('most webhooks');
    view.unmount();
  });

  test('Cancel returns to the list and sends nothing', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    const cancel = [...view.host.querySelectorAll('a')].find((a) => a.textContent === 'Cancel')!;
    act(() => cancel.click());
    await settle(10);
    expect(address()).toBe('/events-gateway');
    expect(view.host.textContent).toContain('the list');
    expect(posts(calls)).toEqual([]);
    view.unmount();
  });
});
