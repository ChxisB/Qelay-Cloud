import { Fragment } from 'react';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Events } from '../src/pages/control/gateway/Events';
import { answer, asking, at, delivery, route, serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  clickSameTick,
  createElement,
  describe,
  expect,
  installTestHooks,
  setInput,
  settle,
  test,
  useToastStore,
} from './server-action-pages.helpers';

installTestHooks();

const EVENTS = '/events-gateway/events';
const openJob = (host: HTMLElement, job: string) =>
  act(() =>
    host
      .querySelector<HTMLButtonElement>(`button[aria-label="Open event emails / ${job}"]`)!
      .click()
  );

describe('Events screen', () => {
  test('lists every event with its status, where it went and what each attempt got back', async () => {
    serveGateway(
      [route()],
      [delivery(), delivery({ id: '1', jobId: 'job-8', status: 'delivered' })]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Failed');
    expect(text).toContain('Successful');
    expect(text).toContain('https://receiver.test/hook');
    expect(text).toContain('#1 502 · #2 503');
    view.unmount();
  });

  test('a row opens the event in full, with every attempt and its reason', async () => {
    serveGateway([route()], [delivery()]);
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    expect(view.host.querySelector('section[aria-label="Event details"]')).toBeNull();
    openJob(view.host, 'job-9');
    const detail = view.host.querySelector('section[aria-label="Event details"]')!;
    expect(detail.textContent).toContain('Attempts (2)');
    expect(detail.textContent).toContain('receiver answered 502');
    expect(detail.textContent).toContain('Qelay jobs: emails');
    view.unmount();
  });

  test('a failed event is retried once however fast Retry is pressed, and the feed refreshes', async () => {
    const calls = serveGateway([route()], [delivery()]);
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    openJob(view.host, 'job-9');
    const before = calls.feed.length;
    const retry = [
      ...view.host.querySelectorAll('section[aria-label="Event details"] button'),
    ].find((button) => button.textContent === 'Retry') as HTMLButtonElement;
    clickSameTick(retry);
    await settle(20);
    expect(
      calls.seen.filter((call) => call === 'POST /webhooks/hook-1/deliveries/2/retry')
    ).toHaveLength(1);
    expect(calls.feed.length).toBeGreaterThan(before);
    view.unmount();
  });

  test('an event that is not failed has no Retry, and one held by a switched-off connection says so', async () => {
    serveGateway(
      [route({ enabled: false })],
      [delivery({ status: 'pending', lastError: null, history: [] })]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    expect(view.host.textContent).toContain('On hold');
    openJob(view.host, 'job-9');
    const detail = view.host.querySelector('section[aria-label="Event details"]')!;
    expect([...detail.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(
      false
    );
    expect(detail.textContent).toContain('The connection is off');
    view.unmount();
  });

  test('the status chip and the address both go to the server', async () => {
    const calls = serveGateway([route()], [delivery(), delivery({ id: '1', status: 'delivered' })]);
    const view = at(`${EVENTS}?route=hook-1&range=7d`, createElement(Events));
    await settle(20);
    expect(calls.feed.at(-1)?.get('webhook')).toBe('hook-1');
    const week = Date.now() - Number(calls.feed.at(-1)?.get('since'));
    expect(Math.abs(week - 7 * 86_400_000)).toBeLessThan(60_000);
    act(() => buttonByText(view.host, 'Failed').click());
    await settle(20);
    expect(calls.feed.at(-1)?.get('status')).toBe('failed');
    expect(calls.feed.at(-1)?.get('webhook')).toBe('hook-1');
    view.unmount();
  });

  test('an attempt in flight has its own chip and word, so no row says Pending that the Pending chip hides', async () => {
    const calls = serveGateway(
      [route()],
      [delivery({ id: '2', status: 'sending', lastError: null, history: [] })]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    expect(view.host.textContent).toContain('Sending');
    act(() => buttonByText(view.host, 'Sending').click());
    await settle(20);
    expect(calls.feed.at(-1)?.get('status')).toBe('sending');
    expect(view.host.textContent).toContain('Sending');
    view.unmount();
  });

  test('the HTTP code and the search narrow the loaded page and never ask the server', async () => {
    const calls = serveGateway(
      [route()],
      [
        delivery(),
        delivery({
          id: '1',
          jobId: 'job-8',
          lastError: null,
          history: [{ attempt: 1, at: 1, durationMs: 3, statusCode: 200, error: null }],
        }),
      ]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    const reads = calls.feed.length;
    setInput(view.host.querySelector<HTMLInputElement>('input[aria-label="HTTP code"]')!, '5');
    await settle(5);
    expect(view.host.textContent).toContain('job-9');
    expect(view.host.textContent).not.toContain('job-8');
    setInput(view.host.querySelector<HTMLInputElement>('input[aria-label="HTTP code"]')!, '');
    setInput(
      view.host.querySelector<HTMLInputElement>('input[aria-label="Search this page"]')!,
      'JOB-8'
    );
    await settle(5);
    expect(view.host.textContent).not.toContain('job-9');
    expect(calls.feed.length).toBe(reads);
    view.unmount();
  });

  test('Retry all failed needs a connection and a yes, and sends only that connection', async () => {
    const calls = serveGateway([route()], [delivery()]);
    const none = at(EVENTS, createElement(Events));
    await settle(20);
    expect(buttonByText(none.host, 'Retry all failed').disabled).toBe(true);
    none.unmount();

    // The dialog goes after the page, so the page's own button comes first while the dialog is still leaving.
    const view = at(
      `${EVENTS}?route=hook-1`,
      createElement(Fragment, null, createElement(Events), createElement(ConfirmDialog))
    );
    await settle(20);
    act(() => buttonByText(view.host, 'Retry all failed').click());
    await settle(10);
    expect(asking()).toMatchObject({
      question: 'Retry every failed event of this connection (up to 500)?',
      confirmLabel: 'Retry all failed',
    });
    answer(false);
    await settle(260);
    expect(calls.seen.filter((call) => call.startsWith('POST'))).toEqual([]);

    act(() => buttonByText(view.host, 'Retry all failed').click());
    await settle(10);
    answer(true);
    await settle(20);
    expect(calls.seen.filter((call) => call.startsWith('POST'))).toEqual([
      'POST /webhooks/hook-1/deliveries/retry',
    ]);
    expect(calls.bodies).toEqual([{ status: 'failed' }]);
    // The answer says how many went back; the server above says 2.
    expect(useToastStore.getState().toasts.map((toast) => toast.detail)).toContain(
      '2 failed events are back in line to be sent.'
    );
    view.unmount();
  });

  test('a queue route names the job it made', async () => {
    serveGateway(
      [route({ destination: 'queue', url: '', target: 'refunds' })],
      [delivery({ status: 'delivered', routedJobId: 'qcloud-route-2', history: [] })]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    expect(view.host.textContent).toContain('Queue: refunds');
    openJob(view.host, 'job-9');
    expect(view.host.querySelector('section[aria-label="Event details"]')?.textContent).toContain(
      'qcloud-route-2'
    );
    view.unmount();
  });

  test('no events, and a server that cannot answer, are each said in words', async () => {
    serveGateway([route()], []);
    const empty = at(EVENTS, createElement(Events));
    await settle(20);
    expect(empty.host.textContent).toContain('No events');
    empty.unmount();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('{"ok":false,"error":"down"}', { status: 500 })
      )) as typeof fetch;
    const failed = at(EVENTS, createElement(Events));
    await settle(20);
    expect(failed.host.textContent).toContain('Something went wrong');
    failed.unmount();
  });
});
