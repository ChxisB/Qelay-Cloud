import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { answer, asking, at, route, serveGateway } from './gateway.helpers';
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
const SECRET = 'generated-secret-value-0123456789';
/** Where the router is, as the address bar would show it. */
let address = '';
const Probe = () => {
  const location = useLocation();
  useEffect(() => {
    address = `${location.pathname}${location.search}${location.hash}`;
  }, [location]);
  return null;
};

const settings = (path: string) =>
  at(
    path,
    createElement(
      'div',
      null,
      createElement(Link, { to: `${BASE}/hook-2/settings` }, 'next'),
      createElement(Probe),
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: `${BASE}/:id/settings`,
          element: createElement(ConnectionPage, { tab: 'settings' }),
        }),
        createElement(Route, { path: '/events-gateway', element: createElement('p', null, 'list') })
      ),
      // After the page, so its buttons come first while the dialog is still leaving.
      createElement(ConfirmDialog)
    )
  );
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);

/** Answers the rotate call the way the Control API does, over a gateway that serves the routes. */
function rotateAnswers(answer: Response | (() => Response)) {
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInit | URL | string, init?: RequestInit) =>
    init?.method === 'POST' && String(input).endsWith('/rotate-secret')
      ? Promise.resolve(typeof answer === 'function' ? answer() : answer)
      : served(input as RequestInfo | URL, init)) as typeof fetch;
}
const issued = () => json({ ok: true, data: { webhook: route(), secret: SECRET } });
const secretIn = (host: HTMLElement) => (host.textContent ?? '').includes(SECRET);

describe('Connection settings: signing secret', () => {
  test('a queue connection has no secret section', async () => {
    serveGateway([route({ destination: 'queue', url: '', target: 'refunds', signed: false })]);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    expect(hasButton(view.host, 'Rotate secret')).toBe(false);
    expect(view.host.textContent).not.toContain('Signing secret');
    view.unmount();
  });

  test('rotating asks first, sends no body, and shows the new secret once with how long the old one lasts', async () => {
    const calls = serveGateway([route()]);
    rotateAnswers(issued);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Rotate secret').click());
    await settle(20);
    expect(asking()).toMatchObject({
      question: 'Rotate the signing secret?',
      detail: 'The old secret keeps working for 24 hours. The new one is shown once.',
      confirmLabel: 'Rotate secret',
    });
    answer(false);
    await settle(20);
    expect(calls.seen).not.toContain('POST /webhooks/hook-1/rotate-secret');
    act(() => buttonByText(view.host, 'Rotate secret').click());
    await settle(20);
    answer(true);
    await settle(30);
    expect(secretIn(view.host)).toBe(true);
    expect(view.host.textContent).toContain('The old secret keeps working for 24 hours');
    expect(view.host.querySelector('button[aria-label="Copy to clipboard"]')).not.toBeNull();
    view.unmount();
  });

  test('the secret is in the page only: not in the address, in storage or in a toast, and leaving clears it', async () => {
    serveGateway([route(), route({ id: 'hook-2' })]);
    rotateAnswers(issued);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Rotate secret').click());
    await settle(20);
    answer(true);
    await settle(30);
    expect(secretIn(view.host)).toBe(true);
    expect(address).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(JSON.stringify(useToastStore.getState().toasts)).not.toContain(SECRET);

    // Another connection's page is the same screen with another id: the secret must not follow.
    act(() => [...view.host.querySelectorAll('a')].find((a) => a.textContent === 'next')!.click());
    await settle(20);
    expect(secretIn(view.host)).toBe(false);
    view.unmount();

    const again = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    expect(secretIn(again.host)).toBe(false);
    again.unmount();
  });

  test('Done takes the secret off the page', async () => {
    serveGateway([route()]);
    rotateAnswers(issued);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Rotate secret').click());
    await settle(20);
    answer(true);
    await settle(30);
    act(() => buttonByText(view.host, 'Done').click());
    await settle(5);
    expect(secretIn(view.host)).toBe(false);
    view.unmount();
  });

  test('a deployment with no signing key says so, in words that do not suggest registering again', async () => {
    serveGateway([route({ signed: false })]);
    rotateAnswers(
      json(
        { ok: false, error: { code: 'webhook_key_missing', message: 'a signing secret needs it' } },
        409
      )
    );
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    // An unsigned connection has no secret to rotate: the button creates the first one.
    expect(hasButton(view.host, 'Rotate secret')).toBe(false);
    act(() => buttonByText(view.host, 'Create secret').click());
    await settle(20);
    expect(asking()).toMatchObject({
      question: 'Create a signing secret?',
      detail: 'Every event from now on is signed. The secret is shown once.',
      confirmLabel: 'Create secret',
    });
    answer(true);
    await settle(30);
    const text = view.host.textContent ?? '';
    expect(text).toContain('QCLOUD_WEBHOOK_KEY');
    expect(text).toContain('no signing key');
    expect(secretIn(view.host)).toBe(false);
    view.unmount();
  });

  test('any other refusal shows the server words', async () => {
    serveGateway([route()]);
    rotateAnswers(
      json({ ok: false, error: { code: 'not_found', message: 'no such webhook' } }, 404)
    );
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Rotate secret').click());
    await settle(20);
    answer(true);
    await settle(30);
    expect(view.host.textContent).toContain('No such webhook');
    view.unmount();
  });
});

describe('Connection settings: remove', () => {
  test('Remove asks first, and a removed connection goes back to the list', async () => {
    const calls = serveGateway([route()]);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Remove connection').click());
    await settle(20);
    expect(asking()).toMatchObject({
      question: 'Remove the connection to https://receiver.test/hook?',
      detail: 'Its events and their history go with it.',
      confirmLabel: 'Remove connection',
      danger: true,
    });
    answer(false);
    await settle(20);
    expect(calls.seen).not.toContain('DELETE /webhooks/hook-1');
    expect(address).toBe(`${BASE}/hook-1/settings`);
    act(() => buttonByText(view.host, 'Remove connection').click());
    await settle(20);
    answer(true);
    await settle(30);
    expect(calls.seen).toContain('DELETE /webhooks/hook-1');
    expect(address).toBe('/events-gateway');
    expect(view.host.textContent).toContain('list');
    view.unmount();
  });

  test('a removal the server refuses stays on the page and says so', async () => {
    serveGateway([route()]);
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? Promise.resolve(json({ ok: false, error: 'the registry is read-only' }, 500))
        : served(input, init)) as typeof fetch;
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    act(() => buttonByText(view.host, 'Remove connection').click());
    await settle(20);
    answer(true);
    await settle(30);
    expect(address).toBe(`${BASE}/hook-1/settings`);
    expect(view.host.textContent).toContain('the registry is read-only');
    view.unmount();
  });
});
