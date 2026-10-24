import { Route, Routes } from 'react-router-dom';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { at, route, serveGateway, type } from './gateway.helpers';
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
} from './server-action-pages.helpers';

installTestHooks();

const settings = () =>
  at(
    '/events-gateway/connections/hook-1/settings',
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/events-gateway/connections/:id/settings',
        element: createElement(ConnectionPage, { tab: 'settings' }),
      })
    )
  );

/** The control a label points at (the form links them by id, and a React id is not a CSS selector). */
const field = <T extends HTMLElement>(host: HTMLElement, label: string) =>
  host.ownerDocument.getElementById(
    [...host.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))!.htmlFor
  ) as T;
const save = (host: HTMLElement) => buttonByText(host, 'Save changes') as HTMLButtonElement;

/** The gateway, with a PATCH that changes the served route the way the server would, or refuses. */
function serveEdits(routes: Record<string, unknown>[], refuse?: Response) {
  const calls = serveGateway(routes);
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return served(input, init);
    calls.seen.push(`PATCH ${new URL(String(input)).pathname}`);
    calls.bodies.push(JSON.parse(String(init.body)));
    if (refuse) return Promise.resolve(refuse);
    const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
    routes[0] = { ...routes[0], ...patch };
    return Promise.resolve(json({ ok: true, data: { webhook: routes[0] } }));
  }) as typeof fetch;
  return calls;
}

describe('Connection settings: editing a connection', () => {
  test("the form holds the connection's own values, and Save waits for a change", async () => {
    serveEdits([
      route({
        name: 'Billing',
        description: 'Failed payments',
        delayMs: 90_000,
        filter: { queue: 'emails' },
      }),
    ]);
    const view = settings();
    await settle(20);
    expect(field<HTMLInputElement>(view.host, 'Name').value).toBe('Billing');
    expect(field<HTMLTextAreaElement>(view.host, 'Description').value).toBe('Failed payments');
    expect(field<HTMLInputElement>(view.host, 'Delay').value).toBe('90');
    expect(field<HTMLTextAreaElement>(view.host, 'Filter').value).toContain('"queue": "emails"');
    expect(save(view.host).disabled).toBe(true);
    expect(view.host.querySelector('[aria-label="Request to be sent"]')).toBeNull();
    view.unmount();
  });

  test('a save sends only the field that changed, shows the request first, then shows what the server holds', async () => {
    const calls = serveEdits([route()]);
    const view = settings();
    await settle(20);
    type(field<HTMLInputElement>(view.host, 'Name'), '  Billing ');
    await settle(2);
    expect(view.host.querySelector('[aria-label="Request to be sent"]')?.textContent).toBe(
      'PATCH /webhooks/hook-1\n{\n  "name": "Billing"\n}'
    );
    expect(save(view.host).disabled).toBe(false);
    await act(async () => save(view.host).click());
    await settle(20);
    expect(calls.seen).toContain('PATCH /webhooks/hook-1');
    expect(calls.bodies.at(-1)).toEqual({ name: 'Billing' });
    expect(field<HTMLInputElement>(view.host, 'Name').value).toBe('Billing');
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe('Saved.');
    expect(save(view.host).disabled).toBe(true);
    view.unmount();
  });

  test('a rule typed wrongly is refused before anything is sent', async () => {
    const calls = serveEdits([route()]);
    const view = settings();
    await settle(20);
    type(field<HTMLTextAreaElement>(view.host, 'Filter'), '{ "queue"');
    await settle(2);
    expect(view.host.textContent).toContain('This is not valid JSON.');
    expect(save(view.host).disabled).toBe(true);
    expect(calls.seen.some((line) => line.startsWith('PATCH'))).toBe(false);
    view.unmount();
  });

  test('a refusal from the server stays beside its field with everything typed, and is not a save', async () => {
    serveEdits(
      [route()],
      json(
        {
          ok: false,
          error: {
            code: 'unsupported_option',
            message: 'The filter cannot use $regex.',
            details: { option: 'filter' },
          },
        },
        400
      )
    );
    const view = settings();
    await settle(20);
    type(field<HTMLInputElement>(view.host, 'Name'), 'Billing');
    type(field<HTMLTextAreaElement>(view.host, 'Filter'), '{ "queue": { "$regex": "x" } }');
    await settle(2);
    await act(async () => save(view.host).click());
    await settle(20);
    expect(view.host.textContent).toContain('The filter cannot use $regex.');
    expect(field<HTMLInputElement>(view.host, 'Name').value).toBe('Billing');
    expect(field<HTMLTextAreaElement>(view.host, 'Filter').value).toBe(
      '{ "queue": { "$regex": "x" } }'
    );
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    view.unmount();
  });

  test("a refusal that names no field is shown as an alert, and Discard puts the connection's values back", async () => {
    serveEdits(
      [route({ name: 'Billing' })],
      json({ ok: false, error: { code: 'internal', message: 'The store is busy.' } }, 500)
    );
    const view = settings();
    await settle(20);
    type(field<HTMLInputElement>(view.host, 'Name'), 'Other');
    await settle(2);
    await act(async () => save(view.host).click());
    await settle(20);
    expect(view.host.querySelector('p[role="alert"]')?.textContent).toBe('The store is busy.');
    await act(async () => buttonByText(view.host, 'Discard changes').click());
    await settle(2);
    expect(field<HTMLInputElement>(view.host, 'Name').value).toBe('Billing');
    expect(view.host.querySelector('p[role="alert"]')).toBeNull();
    view.unmount();
  });

  test('the dedupe fields appear once a window is typed, and the save carries both', async () => {
    const calls = serveEdits([route()]);
    const view = settings();
    await settle(20);
    expect(view.host.textContent).not.toContain('Fields that must repeat');
    type(field<HTMLInputElement>(view.host, 'Deduplicate'), '60');
    await settle(2);
    expect(view.host.textContent).toContain('Fields that must repeat');
    await act(async () => save(view.host).click());
    await settle(20);
    expect(calls.bodies.at(-1)).toEqual({
      dedupe: { windowMs: 60_000, fields: ['body.id'] },
    });
    view.unmount();
  });
});
