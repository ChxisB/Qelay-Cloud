import { createElement, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { act, json, render } from './server-action-pages.helpers';

export const route = (over: Record<string, unknown> = {}) => ({
  id: 'hook-1',
  destination: 'http',
  url: 'https://receiver.test/hook',
  target: null,
  urlRedacted: false,
  events: ['job.failed'],
  queue: 'emails',
  signed: true,
  enabled: true,
  createdAt: 1_000,
  lastTriggered: null,
  successCount: 0,
  failureCount: 1,
  consecutiveFailures: 0,
  alertLevel: 0,
  disabledReason: null,
  disabledAt: null,
  filter: null,
  shape: null,
  delayMs: null,
  dedupe: null,
  ...over,
});

export const delivery = (over: Record<string, unknown> = {}) => ({
  id: '2',
  webhookId: 'hook-1',
  event: 'job.failed',
  queue: 'emails',
  jobId: 'job-9',
  routedJobId: null,
  occurredAt: 1_000,
  status: 'failed',
  attempts: 2,
  nextAttemptAt: 2_000,
  lastStatusCode: 503,
  lastError: 'receiver answered 503',
  history: [
    { attempt: 1, at: 1_000, durationMs: 12, statusCode: 502, error: 'receiver answered 502' },
    { attempt: 2, at: 1_500, durationMs: 9, statusCode: 503, error: 'receiver answered 503' },
  ],
  createdAt: 1_000,
  finishedAt: 3_000,
  ...over,
});

export const stats = (over: Record<string, unknown> = {}) => ({
  since: 0,
  until: 3_600_000,
  bucketMs: 150_000,
  delivered: 8,
  failed: 2,
  pending: 1,
  failureRatio: 0.2,
  avgAttempts: 1.4,
  backlog: 3,
  oldestPendingAt: 500,
  latency: { avgMs: 40, p95Ms: 120, maxMs: 300 },
  buckets: Array.from({ length: 24 }, (_, n) => ({
    from: n * 150_000,
    delivered: n < 4 ? 2 : 0,
    failed: n === 23 ? 2 : 0,
    pending: n === 23 ? 1 : 0,
    avgLatencyMs: 40,
    p95LatencyMs: 120,
  })),
  ...over,
});

/** One route's entry in the grouped stats: 24 hourly buckets, the last with the failures. */
export const groupStat = (over: Record<string, unknown> = {}) => ({
  webhookId: 'hook-1',
  delivered: 8,
  failed: 2,
  pending: 1,
  failureRatio: 0.2,
  backlog: 1,
  oldestPendingAt: 500,
  buckets: Array.from({ length: 24 }, (_, n) => ({
    from: n * 3_600_000,
    delivered: n < 4 ? 2 : 0,
    failed: n === 23 ? 2 : 0,
    pending: n === 23 ? 1 : 0,
  })),
  ...over,
});

/** One issue as the Control API sends it: open, on `hook-1`, with a streak of seven. */
export const issue = (over: Record<string, unknown> = {}) => ({
  id: '1',
  webhookId: 'hook-1',
  webhookName: null,
  status: 'open',
  kind: 'delivery_failed',
  openedAt: 1_000,
  updatedAt: 1_000,
  updatedBy: null,
  consecutiveFailures: 7,
  alertLevel: 2,
  pausedBy: null,
  ...over,
});

/** One saved destination as the Control API sends it: a webhook address, used by two connections. */
export const destination = (over: Record<string, unknown> = {}) => ({
  id: 'dest-1',
  name: 'Billing receiver',
  kind: 'http',
  url: 'https://billing.test/hook',
  urlRedacted: false,
  target: null,
  connections: 2,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

export interface Calls {
  /** `METHOD /path?query` of every request, in order. */
  readonly seen: string[];
  readonly bodies: unknown[];
  /** The query of every read of the feed. */
  readonly feed: URLSearchParams[];
}

/** A gateway server with the routes, events and stats given; the 404 for anything else fails the test loudly. */
export function serveGateway(
  routes: unknown[],
  deliveries: unknown[] = [],
  statistics: unknown = stats(),
  /** The grouped stats; left out, the server answers a grouped read as one that predates it (the single answer). */
  grouped?: unknown[],
  /** The issues, changed in place by a status change; left out, the server answers as one that predates them (404). */
  issues?: Array<Record<string, unknown>>,
  /** The saved destinations, changed in place by an add, an edit or a remove; left out, the server predates them (404). */
  destinations?: Array<Record<string, unknown>>
): Calls {
  const calls: Calls = { seen: [], bodies: [], feed: [] };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.seen.push(`${method} ${url.pathname}${url.search}`);
    if (init?.body !== undefined) calls.bodies.push(JSON.parse(String(init.body)));
    const path = url.pathname;
    if (method === 'GET' && path === '/webhooks') {
      return Promise.resolve(json({ ok: true, data: { webhooks: routes } }));
    }
    if (method === 'GET' && path === '/webhooks/deliveries') {
      calls.feed.push(url.searchParams);
      const status = url.searchParams.get('status');
      const hook = url.searchParams.get('webhook');
      const rows = deliveries.filter(
        (row) =>
          (status === null || (row as { status: string }).status === status) &&
          (hook === null || (row as { webhookId: string }).webhookId === hook)
      );
      return Promise.resolve(json({ ok: true, data: { deliveries: rows, next: null } }));
    }
    if (path.startsWith('/webhooks/issues')) {
      if (!issues) {
        return Promise.resolve(
          json({ ok: false, error: { code: 'not_found', message: 'no such route' } }, 404)
        );
      }
      if (method === 'PUT') {
        const found = issues.find((row) => row.id === path.split('/').pop());
        if (!found)
          return Promise.resolve(
            json({ ok: false, error: { code: 'issue_not_found', message: 'issue not found' } }, 404)
          );
        found.status = (JSON.parse(String(init?.body)) as { status: string }).status;
        return Promise.resolve(json({ ok: true, data: { issue: found } }));
      }
      const status = url.searchParams.get('status') ?? 'open';
      const counts = Object.fromEntries(
        ['open', 'acknowledged', 'resolved', 'ignored'].map((name) => [
          name,
          issues.filter((row) => row.status === name).length,
        ])
      );
      const rows = issues.filter((row) => row.status === status);
      return Promise.resolve(json({ ok: true, data: { issues: rows, next: null, counts } }));
    }
    if (path.startsWith('/webhooks/destinations')) {
      if (!destinations) {
        return Promise.resolve(
          json({ ok: false, error: { code: 'not_found', message: 'no such route' } }, 404)
        );
      }
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as object);
      const found = destinations.find((row) => row.id === path.split('/')[3]);
      if (method === 'POST') {
        const added = destination({
          ...body,
          id: `dest-${destinations.length + 1}`,
          connections: 0,
        });
        destinations.push(added);
        return Promise.resolve(json({ ok: true, data: { destination: added } }, 201));
      }
      if (method !== 'GET' && !found) {
        const error = { code: 'destination_not_found', message: 'destination not found' };
        return Promise.resolve(json({ ok: false, error }, 404));
      }
      if (method === 'PATCH') Object.assign(found!, body);
      if (method === 'DELETE') destinations.splice(destinations.indexOf(found!), 1);
      return Promise.resolve(
        json({ ok: true, data: method === 'GET' ? { destinations } : { destination: found } })
      );
    }
    if (method === 'GET' && path === '/webhooks/stats') {
      if (grouped && url.searchParams.get('groupBy') === 'webhook') {
        const data = { since: 0, until: 86_400_000, bucketMs: 3_600_000, groups: grouped };
        return Promise.resolve(json({ ok: true, data }));
      }
      return Promise.resolve(json({ ok: true, data: { stats: statistics } }));
    }
    if (method === 'PUT' || method === 'POST' || method === 'DELETE' || method === 'PATCH') {
      return Promise.resolve(
        json({ ok: true, data: { retried: 2 } }, method === 'POST' ? 202 : 200)
      );
    }
    return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
  }) as typeof fetch;
  return calls;
}

/** A gateway screen at an address, in the router its tabs, links and filters read. */
export const at = (path: string, page: ReactElement) =>
  render(createElement(MemoryRouter, { initialEntries: [path] }, page));

/** The caller may only read, until the next test: test/setup.ts puts the operator back before each one. */
export const asViewer = () =>
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: { ...DEMO_CAPABILITIES, principal: { role: 'viewer' } },
    error: null,
    key: 'test',
  });

/** Sets what the user typed, on an input or a textarea, the way the form hears it. */
export function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** The question the page is asking in its own dialog, or null. The dialog itself is mounted by the shell, not here. */
export const asking = () => useConfirmStore.getState().current;

/** Answers that question the way its buttons would: true for the main one, false for Cancel and Escape. */
export function answer(confirmed: boolean): void {
  const question = asking();
  if (!question) throw new Error('No question is open');
  act(() => useConfirmStore.getState().answer(question.id, confirmed));
}

/** Opens the "More" menu of one connection and returns it. */
export function openMenu(host: HTMLElement, name: string): HTMLElement {
  const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="More for ${name}"]`);
  if (!trigger) throw new Error(`No menu for ${name}`);
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  return host.querySelector<HTMLElement>('[role="menu"]')!;
}

/** The item of an open menu with this label. */
export function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === label
  );
  if (!item) throw new Error(`No item "${label}"`);
  return item;
}
