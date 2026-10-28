import { Fragment } from 'react';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Sources } from '../src/pages/control/gateway/Sources';
import { field } from './gateway-destinations.helpers';
import { source } from './gateway-sources.helpers';
import { answer, asking, asViewer, at, serveGateway } from './gateway.helpers';
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

const screen = () =>
  at(
    '/events-gateway/sources',
    createElement(Fragment, null, createElement(Sources), createElement(ConfirmDialog))
  );
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);
const TOKEN = `qin_${'a'.repeat(43)}`;

/** Answers this method on `/sources…` with a refusal, and leaves the rest to the fixture. */
function refuse(method: string, status: number, code: string, details?: object) {
  const served = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? 'GET') === method && new URL(String(input)).pathname.startsWith('/sources')
      ? Promise.resolve(
          json({ ok: false, error: { code, message: code.replaceAll('_', ' '), details } }, status)
        )
      : served(input, init)) as typeof fetch;
}

describe('Gateway sources: reading', () => {
  test('a source is listed with how it checks, and links to its requests', async () => {
    serveGateway([], [], undefined, undefined, undefined, undefined, [
      source({
        verification: { kind: 'hmac', header: 'x-signature', username: null },
        signed: true,
      }),
    ]);
    const view = screen();
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Shop checkout');
    expect(text).toContain('Signature');
    expect(text).toContain('signature of its body in the x-signature header');
    expect(
      view.host.querySelector('a[href="/events-gateway/requests?source=src_1"]')
    ).not.toBeNull();
    expect(hasButton(view.host, 'New secret')).toBe(true);
    view.unmount();
  });

  test('a viewer reads the list and has nothing to press', async () => {
    asViewer();
    serveGateway([]);
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('Shop checkout');
    for (const label of ['Add source', 'Turn off', 'New address', 'Remove']) {
      expect(hasButton(view.host, label)).toBe(false);
    }
    view.unmount();
  });

  test('a server that predates sources says so instead of failing', async () => {
    serveGateway([]);
    refuse('GET', 404, 'not_found');
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('Sources are not available');
    view.unmount();
  });

  test('with none the page says what a source is for', async () => {
    serveGateway([], [], undefined, undefined, undefined, undefined, []);
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('No sources yet');
    view.unmount();
  });
});

describe('Gateway sources: adding', () => {
  const open = async (rows: Array<Record<string, unknown>> = []) => {
    const calls = serveGateway([], [], undefined, undefined, undefined, undefined, rows);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add source').click());
    return { calls, view };
  };

  test('a source with no check is added by its name, and its path is shown once', async () => {
    const { calls, view } = await open();
    setInput(field(view.host, 'Name'), 'Shop checkout');
    act(() => buttonByText(view.host, 'Add source').click());
    await settle(30);
    expect(calls.bodies).toEqual([{ name: 'Shop checkout' }]);
    expect(view.host.textContent).toContain(`/s/${TOKEN}`);
    expect(view.host.textContent).not.toContain('Secret');
    act(() => buttonByText(view.host, 'Done').click());
    await settle(10);
    expect(view.host.textContent).not.toContain(TOKEN);
    view.unmount();
  });

  test('a signed source sends its header and shows the secret that was made', async () => {
    const { calls, view } = await open();
    setInput(field(view.host, 'Name'), 'Shop checkout');
    act(() => buttonByText(view.host, 'Signature').click());
    expect(field<HTMLInputElement>(view.host, 'Header').value).toBe('x-signature');
    act(() => buttonByText(view.host, 'Add source').click());
    await settle(30);
    expect(calls.bodies).toEqual([
      { name: 'Shop checkout', verification: { kind: 'hmac', header: 'x-signature' } },
    ]);
    expect(view.host.textContent).toContain('made-secret-0123456789');
    view.unmount();
  });

  test('a short secret is refused beside its field before anything is sent', async () => {
    const { calls, view } = await open();
    setInput(field(view.host, 'Name'), 'Shop checkout');
    act(() => buttonByText(view.host, 'API key').click());
    setInput(field(view.host, 'Secret'), 'short');
    act(() => buttonByText(view.host, 'Add source').click());
    await settle(10);
    expect(calls.seen.filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(field<HTMLInputElement>(view.host, 'Secret').getAttribute('aria-invalid')).toBe('true');
    expect(view.host.textContent).toContain('16 to 256 characters');
    view.unmount();
  });

  test('a name that is taken is shown beside the name and keeps what was typed', async () => {
    const { view } = await open([source()]);
    refuse('POST', 409, 'source_name_taken');
    setInput(field(view.host, 'Name'), 'Shop checkout');
    act(() => buttonByText(view.host, 'Add source').click());
    await settle(30);
    const name = field<HTMLInputElement>(view.host, 'Name');
    expect(name.value).toBe('Shop checkout');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    view.unmount();
  });
});

describe('Gateway sources: changing and removing', () => {
  test('a new address asks first, then shows the new path once', async () => {
    const calls = serveGateway([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'New address').click());
    await settle(10);
    expect(asking()?.question).toContain('The old address stops working at once');
    answer(true);
    await settle(30);
    expect(calls.seen).toContain('POST /sources/src_1/rotate-token');
    expect(view.host.textContent).toContain(`/s/qin_${'b'.repeat(43)}`);
    view.unmount();
  });

  test('turning a source off sends enabled false without asking', async () => {
    const calls = serveGateway([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Turn off').click());
    await settle(30);
    expect(calls.bodies).toEqual([{ enabled: false }]);
    expect(view.host.textContent).toContain('It is off');
    view.unmount();
  });

  test('Remove asks first, and a removed source leaves the list', async () => {
    const calls = serveGateway([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    answer(false);
    await settle(10);
    expect(calls.seen.filter((call) => call.startsWith('DELETE'))).toEqual([]);
    await settle(260);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    answer(true);
    await settle(30);
    expect(calls.seen).toContain('DELETE /sources/src_1');
    expect(view.host.textContent).toContain('No sources yet');
    view.unmount();
  });

  test('a source in use is refused with how many connections read it', async () => {
    serveGateway([]);
    refuse('DELETE', 409, 'source_in_use', { routes: 2 });
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    answer(true);
    await settle(30);
    const text = view.host.textContent ?? '';
    expect(text).toContain('"Shop checkout" was not changed');
    expect(text).toContain('2 connections are made from it. Remove or move them first.');
    expect(text).toContain('Shop checkout');
    view.unmount();
  });
});
