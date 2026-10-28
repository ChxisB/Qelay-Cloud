import { Fragment, useEffect } from 'react';
import { Route, Routes, useLocation, useParams } from 'react-router-dom';
import { CreateConnection } from '../src/pages/control/gateway/CreateConnection';
import { NEW_CONNECTION } from '../src/pages/control/gateway/model';
import { at } from './gateway.helpers';
import { act, createElement } from './server-action-pages.helpers';

export const field = (host: HTMLElement, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
export const sourceSelect = (host: HTMLElement) =>
  host.querySelector<HTMLSelectElement>('select[name="webhook-source"]')!;
/** Picks a source by id, the way a person would: the option has to be there, so the sources must have loaded. */
export function pickSource(host: HTMLElement, id: string) {
  const select = sourceSelect(host);
  act(() => {
    select.value = id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
export const posts = (calls: { seen: string[] }) =>
  calls.seen.filter((call) => call.startsWith('POST'));
export const alertOf = (host: HTMLElement) => host.querySelector('p[role="alert"]');
/** The heading of the step an element sits in. */
export const stepOf = (element: Element | null) =>
  element?.closest('section')?.querySelector('h3')?.textContent;

/** Where the router is, as the address bar would show it. */
let at_ = '';
export const address = () => at_;
const Probe = () => {
  const location = useLocation();
  useEffect(() => {
    at_ = location.pathname;
  }, [location]);
  return null;
};
const Landed = () => createElement('p', null, `landed on ${useParams().id}`);

export const page = () =>
  at(
    NEW_CONNECTION,
    createElement(
      Fragment,
      null,
      createElement(Probe),
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/events-gateway/connections/new',
          element: createElement(CreateConnection),
        }),
        createElement(Route, {
          path: '/events-gateway/connections/:id',
          element: createElement(Landed),
        }),
        createElement(Route, {
          path: '/events-gateway',
          element: createElement('p', null, 'the list'),
        })
      )
    )
  );

/** Answer `POST /webhooks` with this, and leave every other call to the gateway fixture. */
export const answerAdd = (reply: Response) => {
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' && new URL(String(input)).pathname === '/webhooks'
      ? Promise.resolve(reply)
      : served(input, init)) as typeof fetch;
};
