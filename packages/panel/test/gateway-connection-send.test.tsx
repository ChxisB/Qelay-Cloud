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

const field = <T extends HTMLElement>(host: HTMLElement, label: string) =>
  host.ownerDocument.getElementById(
    [...host.querySelectorAll('label')].find((item) => item.textContent === label)!.htmlFor
  ) as T;
const save = (host: HTMLElement) => buttonByText(host, 'Save changes') as HTMLButtonElement;
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
const sent = (host: HTMLElement) =>
  host.querySelector('[aria-label="Request to be sent"]')?.textContent;
const batchSwitch = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Send in batches"]');

/** The gateway, with a PATCH that changes the served route the way the server would, or refuses. */
function serveEdits(routes: Record<string, unknown>[], refuse?: Response) {
  const calls = serveGateway(routes);
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return served(input, init);
    calls.seen.push(`PATCH ${new URL(String(input)).pathname}`);
    calls.bodies.push(JSON.parse(String(init.body)));
    if (refuse) return Promise.resolve(refuse);
    routes[0] = { ...routes[0], ...(JSON.parse(String(init.body)) as object) };
    return Promise.resolve(json({ ok: true, data: { webhook: routes[0] } }));
  }) as typeof fetch;
  return calls;
}

describe('Connection settings: when and how events are sent', () => {
  test('a nightly schedule in a zone and a batch are chosen, shown as the request, and saved', async () => {
    const calls = serveEdits([route()]);
    const view = settings();
    await settle(20);
    expect(field<HTMLSelectElement>(view.host, 'Send').value).toBe('');
    expect(view.host.textContent).not.toContain('Time zone');
    expect(view.host.textContent).not.toContain('Events per request');

    choose(field<HTMLSelectElement>(view.host, 'Send'), '0 0 * * *');
    await settle(2);
    choose(field<HTMLSelectElement>(view.host, 'Time zone'), 'Europe/London');
    await act(async () => batchSwitch(view.host)!.click());
    await settle(2);
    type(field<HTMLInputElement>(view.host, 'Events per request'), '50');
    await settle(2);

    expect(sent(view.host)).toBe(
      `PATCH /webhooks/hook-1\n${JSON.stringify(
        {
          schedule: { cron: '0 0 * * *', timezone: 'Europe/London' },
          batch: { maxEvents: 50, maxBytes: 262_144 },
        },
        null,
        2
      )}`
    );
    await act(async () => save(view.host).click());
    await settle(20);
    expect(calls.bodies.at(-1)).toEqual({
      schedule: { cron: '0 0 * * *', timezone: 'Europe/London' },
      batch: { maxEvents: 50, maxBytes: 262_144 },
    });
    expect(field<HTMLSelectElement>(view.host, 'Send').value).toBe('0 0 * * *');
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe('Saved.');
    view.unmount();
  });

  test('a cron of your own opens a box for it, and sending at once again clears the schedule', async () => {
    const calls = serveEdits([
      route({ schedule: { cron: '15 3 * * *', timezone: 'UTC' }, nextSendAt: 1_800_000_000_000 }),
    ]);
    const view = settings();
    await settle(20);
    expect(field<HTMLSelectElement>(view.host, 'Send').value).toBe('custom');
    expect(field<HTMLInputElement>(view.host, 'Cron').value).toBe('15 3 * * *');
    expect(save(view.host).disabled).toBe(true);

    choose(field<HTMLSelectElement>(view.host, 'Send'), '');
    await settle(2);
    expect(view.host.textContent).not.toContain('Time zone');
    await act(async () => save(view.host).click());
    await settle(20);
    expect(calls.bodies.at(-1)).toEqual({ schedule: null });
    view.unmount();
  });

  test('a cron left empty is refused before anything is sent', async () => {
    const calls = serveEdits([route()]);
    const view = settings();
    await settle(20);
    choose(field<HTMLSelectElement>(view.host, 'Send'), 'custom');
    await settle(2);
    expect(view.host.textContent).toContain('Write a cron expression');
    expect(save(view.host).disabled).toBe(true);
    expect(calls.seen.some((line) => line.startsWith('PATCH'))).toBe(false);
    view.unmount();
  });

  test('a schedule the server refuses stays beside its box with what was typed', async () => {
    serveEdits(
      [route()],
      json(
        {
          ok: false,
          error: {
            code: 'unsupported_option',
            message: 'schedule: it fires less often than once a month.',
            details: { option: 'schedule' },
          },
        },
        400
      )
    );
    const view = settings();
    await settle(20);
    choose(field<HTMLSelectElement>(view.host, 'Send'), 'custom');
    await settle(2);
    type(field<HTMLInputElement>(view.host, 'Cron'), '0 0 1 1 *');
    await settle(2);
    await act(async () => save(view.host).click());
    await settle(20);
    expect(view.host.textContent).toContain('fires less often than once a month');
    expect(field<HTMLInputElement>(view.host, 'Cron').value).toBe('0 0 1 1 *');
    view.unmount();
  });

  test('a queue connection can be scheduled but has no batch to switch on', async () => {
    serveEdits([route({ destination: 'queue', url: '', target: 'nightly-jobs' })]);
    const view = settings();
    await settle(20);
    expect(field<HTMLSelectElement>(view.host, 'Send')).not.toBeNull();
    expect(batchSwitch(view.host)).toBeNull();
    view.unmount();
  });
});
