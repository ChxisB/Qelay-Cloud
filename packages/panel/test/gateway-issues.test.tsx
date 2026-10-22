import { Issues } from '../src/pages/control/gateway/Issues';
import { asViewer, at, issue, route, serveGateway } from './gateway.helpers';
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

const ISSUES = '/events-gateway/issues';
const tab = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('nav[aria-label="Issue status"] a')].find((a) =>
    a.textContent?.startsWith(text)
  );
const cards = (host: HTMLElement) =>
  [...host.querySelectorAll('li')].map((li) => li.textContent ?? '');
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);

const routes = () => [
  route(),
  route({ id: 'hook-2', url: 'https://receiver.test/two', name: 'Billing' }),
];
const all = () => [
  issue(),
  issue({ id: '2', webhookId: 'hook-2', consecutiveFailures: 3, alertLevel: 1 }),
  issue({ id: '3', status: 'acknowledged', updatedAt: 2_000, updatedBy: 'ops@example.test' }),
  issue({ id: '4', status: 'resolved', updatedAt: 3_000, consecutiveFailures: 0 }),
  issue({ id: '5', status: 'ignored', updatedAt: 4_000 }),
];

describe('Issues screen: with issues on the server', () => {
  test('counts every status in its tab and lists only the open ones first', async () => {
    serveGateway(routes(), [], undefined, undefined, all());
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    expect(
      ['Open 2', 'Acknowledged 1', 'Resolved 1', 'Ignored 1'].map((text) => !!tab(view.host, text))
    ).toEqual([true, true, true, true]);
    expect(tab(view.host, 'Open')?.getAttribute('aria-current')).toBe('page');
    expect(tab(view.host, 'Resolved')?.getAttribute('href')).toBe(`${ISSUES}?status=resolved`);
    const items = cards(view.host);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('7 events failed in a row');
    expect(items[1]).toContain('3 events failed in a row');
    expect(items[1]).toContain('Billing');
    view.unmount();
  });

  test('a tab lists only its status, and says who last changed it when it is known', async () => {
    serveGateway(routes(), [], undefined, undefined, all());
    const view = at(`${ISSUES}?status=acknowledged`, createElement(Issues));
    await settle(20);
    const items = cards(view.host);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('Acknowledged');
    expect(items[0]).toContain('By ops@example.test.');
    expect(tab(view.host, 'Acknowledged')?.getAttribute('aria-current')).toBe('page');
    view.unmount();
  });

  test('an unknown status in the address is the open tab', async () => {
    const calls = serveGateway(routes(), [], undefined, undefined, all());
    const view = at(`${ISSUES}?status=bogus`, createElement(Issues));
    await settle(20);
    expect(calls.seen.some((line) => line.includes('/webhooks/issues?status=open'))).toBe(true);
    expect(cards(view.host)).toHaveLength(2);
    view.unmount();
  });

  test('Acknowledge sends the status, then the issue leaves Open and the counts follow', async () => {
    const calls = serveGateway(routes(), [], undefined, undefined, all());
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    act(() =>
      buttonByText(view.host.querySelectorAll('li')[0] as HTMLElement, 'Acknowledge').click()
    );
    await settle(30);
    expect(calls.seen).toContain('PUT /webhooks/issues/1');
    expect(calls.bodies).toContainEqual({ status: 'acknowledged' });
    expect(cards(view.host)).toHaveLength(1);
    expect(tab(view.host, 'Open 1')).toBeTruthy();
    expect(tab(view.host, 'Acknowledged 2')).toBeTruthy();
    view.unmount();
  });

  test('each status offers what can follow, and a resolved issue is history', async () => {
    serveGateway(routes(), [], undefined, undefined, all());
    const words = async (status: string) => {
      const view = at(`${ISSUES}?status=${status}`, createElement(Issues));
      await settle(20);
      const buttons = [...view.host.querySelectorAll('li button')].map((b) => b.textContent);
      view.unmount();
      return buttons;
    };
    expect(await words('open')).toEqual([
      'Acknowledge',
      'Ignore',
      'Resolve',
      'Acknowledge',
      'Ignore',
      'Resolve',
    ]);
    expect(await words('acknowledged')).toEqual(['Ignore', 'Resolve', 'Reopen']);
    expect(await words('ignored')).toEqual(['Reopen', 'Resolve']);
    expect(await words('resolved')).toEqual([]);
  });

  test('a refusal says why and changes nothing', async () => {
    serveGateway(routes(), [], undefined, undefined, all());
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Promise.resolve(
            json({ ok: false, error: { code: 'internal', message: 'the store is busy' } }, 500)
          )
        : served(input, init)) as typeof fetch;
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    act(() => buttonByText(view.host.querySelectorAll('li')[0] as HTMLElement, 'Ignore').click());
    await settle(30);
    expect(view.host.textContent).toContain('The store is busy.');
    expect(cards(view.host)).toHaveLength(2);
    expect(tab(view.host, 'Open 2')).toBeTruthy();
    view.unmount();
  });

  test('an issue resolved meanwhile is refused with the server words and the list is read again', async () => {
    const rows = all();
    const calls = serveGateway(routes(), [], undefined, undefined, rows);
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return served(input, init);
      rows[0]!.status = 'resolved';
      return Promise.resolve(
        json(
          {
            ok: false,
            error: { code: 'issue_resolved', message: 'the issue is resolved, which is history' },
          },
          409
        )
      );
    }) as typeof fetch;
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    const reads = () => calls.seen.filter((line) => line.startsWith('GET /webhooks/issues')).length;
    const before = reads();
    act(() => buttonByText(view.host.querySelectorAll('li')[0] as HTMLElement, 'Resolve').click());
    await settle(30);
    expect(view.host.textContent).toContain('The issue is resolved, which is history.');
    expect(reads()).toBeGreaterThan(before);
    expect(cards(view.host)).toHaveLength(1);
    view.unmount();
  });

  test('a connection paused after failures can be resumed from its issue', async () => {
    const calls = serveGateway(
      [
        route({
          enabled: false,
          pausedBy: 'failures',
          disabledReason: '10 failed deliveries in a row',
        }),
      ],
      [],
      undefined,
      undefined,
      [issue({ pausedBy: 'failures', alertLevel: 4 })]
    );
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    expect(cards(view.host)[0]).toContain('Paused after failures');
    act(() => buttonByText(view.host, 'Resume connection').click());
    await settle(30);
    expect(calls.seen).toContain('PUT /webhooks/hook-1/enabled');
    expect(calls.bodies).toContainEqual({ enabled: true });
    view.unmount();
  });

  test('a viewer reads the issues and can open the events, but has nothing to press', async () => {
    asViewer();
    serveGateway(
      [
        route({ enabled: false, pausedBy: 'failures', disabledReason: 'x' }),
        route({ id: 'hook-2' }),
      ],
      [],
      undefined,
      undefined,
      [issue({ pausedBy: 'failures' }), issue({ id: '2', webhookId: 'hook-2' })]
    );
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    expect(cards(view.host)).toHaveLength(2);
    for (const word of ['Acknowledge', 'Ignore', 'Resolve', 'Resume connection']) {
      expect(hasButton(view.host, word)).toBe(false);
    }
    expect(
      [...view.host.querySelectorAll('a')].some((a) => a.textContent === 'View failed events')
    ).toBe(true);
    view.unmount();
  });

  test('an empty tab says what belongs there', async () => {
    serveGateway(routes(), [], undefined, undefined, []);
    const view = at(`${ISSUES}?status=ignored`, createElement(Issues));
    await settle(20);
    expect(view.host.textContent).toContain('Nothing ignored');
    expect(tab(view.host, 'Open 0')).toBeTruthy();
    view.unmount();
  });

  test('an issue whose connection is gone is still listed by what the server knows, without links to it', async () => {
    serveGateway([], [], undefined, undefined, [issue({ webhookName: 'Old billing' })]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    const [item] = cards(view.host);
    expect(item).toContain('Old billing');
    expect(item).not.toContain('View failed events');
    view.unmount();
  });

  test('a server from before issues gets the list worked out from the connections, with no tabs', async () => {
    serveGateway([route({ consecutiveFailures: 7, alertLevel: 2 })]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    expect(view.host.querySelector('nav[aria-label="Issue status"]')).toBeNull();
    expect(cards(view.host)[0]).toContain('7 events failed in a row');
    view.unmount();
  });
});
