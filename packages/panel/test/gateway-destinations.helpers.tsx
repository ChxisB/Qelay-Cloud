import { Fragment } from 'react';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Destinations } from '../src/pages/control/gateway/Destinations';
import { at, destination, serveGateway } from './gateway.helpers';
import { createElement, json } from './server-action-pages.helpers';

export type Row = Record<string, unknown>;

/** The page, then the shell's question dialog (after it, so the page's buttons come first while the dialog leaves). */
export const screen = () =>
  at(
    '/events-gateway/destinations',
    createElement(Fragment, null, createElement(Destinations), createElement(ConfirmDialog))
  );

/** The gateway with these destinations (none at all is a server that predates them). */
export const serve = (rows?: Row[]) => serveGateway([], [], undefined, undefined, undefined, rows);

export const two = (): Row[] => [
  destination(),
  destination({
    id: 'dest-2',
    name: 'Refunds',
    kind: 'queue',
    url: '',
    target: 'refunds',
    connections: 1,
  }),
];

/** The control a label points at (the forms link them by id, and a React id is not a CSS selector). */
export const field = <T extends HTMLElement>(host: HTMLElement, label: string) =>
  host.ownerDocument.getElementById(
    [...host.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))!.htmlFor
  ) as T;

/** Answers this method on `/webhooks/destinations…` with the refusal, and leaves the rest to the fixture. */
export function refuse(method: string, status: number, code: string, details?: object) {
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === method && new URL(String(input)).pathname.startsWith('/webhooks/destinations')
      ? Promise.resolve(
          json({ ok: false, error: { code, message: code.replaceAll('_', ' '), details } }, status)
        )
      : served(input, init)) as typeof fetch;
}
