import { Fragment } from 'react';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Requests } from '../src/pages/control/gateway/Requests';
import { inboundRequest, source } from './gateway-sources.helpers';
import { answer, asViewer, at, delivery, route, serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
  useToastStore,
} from './server-action-pages.helpers';

installTestHooks();

const screen = (path = '/events-gateway/requests') =>
  at(path, createElement(Fragment, null, createElement(Requests), createElement(ConfirmDialog)));
const open = (host: HTMLElement, id: string) =>
  act(() =>
    host
      .querySelector<HTMLButtonElement>(
        `button[aria-label^="Open request "][aria-label$=" ${id}"]`
      )!
      .click()
  );
const rejected = inboundRequest({
  id: '10',
  status: 'rejected',
  cause: 'the signature did not match',
  bodyBytes: null,
});
const BODY = '{"id":500,"name":"chris"}';

describe('Gateway requests', () => {
  test('requests are listed newest first with the source name and the cause of a refusal', async () => {
    serveGateway(
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [source()],
      [rejected, inboundRequest()]
    );
    const view = screen();
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Shop checkout');
    expect(text).toContain('POST 9');
    expect(text).toContain('the signature did not match');
    expect(text.indexOf('POST 10')).toBeLessThan(text.indexOf('POST 9'));
    view.unmount();
  });

  test('the status chips and the source in the address narrow what is asked', async () => {
    const calls = serveGateway(
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [source()],
      [rejected, inboundRequest()]
    );
    const view = screen('/events-gateway/requests?source=src_1');
    await settle(20);
    expect(calls.seen).toContain('GET /requests?limit=100&source=src_1');
    act(() => buttonByText(view.host, 'Rejected').click());
    await settle(30);
    expect(calls.seen).toContain('GET /requests?limit=100&status=rejected&source=src_1');
    expect(view.host.textContent).toContain('POST 10');
    expect(view.host.textContent).not.toContain('POST 9');
    view.unmount();
  });

  test('with none the page says when a request appears', async () => {
    serveGateway([]);
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('No requests');
    view.unmount();
  });

  test('a request opens with what was posted, drawn as text, and the events it made', async () => {
    const made = { ...delivery({ id: '7', webhookId: 'hook-1' }), requestId: '9', via: 'http' };
    serveGateway(
      [route()],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [source()],
      [{ ...inboundRequest(), deliveries: [made] }]
    );
    const view = screen();
    await settle(20);
    open(view.host, '9');
    await settle(30);
    const text = view.host.textContent ?? '';
    expect(text).toContain(BODY);
    expect(text).toContain('authorization');
    expect(text).toContain('[redacted]');
    expect(text).toContain('page');
    expect(text).toContain('Events made (1)');
    expect(text).toContain('by web address');
    view.unmount();
  });

  test('a rejected request says why and has no Replay', async () => {
    serveGateway([], [], undefined, undefined, undefined, undefined, [source()], [rejected]);
    const view = screen();
    await settle(20);
    open(view.host, '10');
    await settle(30);
    expect(view.host.querySelector('section[aria-label="Request details"]')?.textContent).toContain(
      'Not accepted'
    );
    expect([...view.host.querySelectorAll('button')].some((b) => b.textContent === 'Replay')).toBe(
      false
    );
    view.unmount();
  });

  test('Replay asks first, then says how many events are back in line', async () => {
    const calls = serveGateway(
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [source()],
      [inboundRequest()]
    );
    const view = screen();
    await settle(20);
    open(view.host, '9');
    await settle(30);
    act(() => buttonByText(view.host, 'Replay').click());
    await settle(10);
    answer(true);
    await settle(30);
    expect(calls.seen).toContain('POST /requests/9/replay');
    expect(useToastStore.getState().toasts.map((toast) => toast.detail)).toContain(
      '1 event is back in line, from 1 connection.'
    );
    view.unmount();
  });

  test('a viewer reads the request but cannot replay it', async () => {
    asViewer();
    serveGateway(
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [source()],
      [inboundRequest()]
    );
    const view = screen();
    await settle(20);
    open(view.host, '9');
    await settle(30);
    expect([...view.host.querySelectorAll('button')].some((b) => b.textContent === 'Replay')).toBe(
      false
    );
    view.unmount();
  });
});
