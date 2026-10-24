import { answer, asking, menuItem, openMenu } from './gateway.helpers';
import {
  clickSameTick,
  ConnectionsPage,
  createElement,
  deferred,
  describe,
  expect,
  installTestHooks,
  json,
  render,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks({ yesToQuestions: true });

describe('webhook mutation intent', () => {
  const webhook = (enabled = false) => ({
    id: 'hook-1',
    url: 'https://example.test/hook',
    urlRedacted: false,
    signed: false,
    source: 'src_1',
    enabled,
    successCount: 0,
    failureCount: 0,
    lastTriggered: null,
    createdAt: 1_000,
  });

  test('same-tick deletes issue one mutation', async () => {
    const remove = deferred<Response>();
    let removeCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook()] } }));
      }
      if (url.endsWith('/webhooks/hook-1') && method === 'DELETE') {
        removeCalls += 1;
        return remove.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(ConnectionsPage));
    await settle(20);
    const item = menuItem(openMenu(view.host, 'https://example.test/hook'), 'Remove connection');
    clickSameTick(item as HTMLButtonElement);
    await settle(5);
    // Each click asks in the page; the answer is given for every question.
    while (asking()) answer(true);
    await settle(5);
    expect(removeCalls).toBe(1);
    remove.resolve(json({ ok: true }));
    await settle(20);
    view.unmount();
  });

  test('serializes and coalesces toggle writes so the latest intent wins on the server', async () => {
    const toggles: Array<{
      request: ReturnType<typeof deferred<Response>>;
      enabled: boolean;
    }> = [];
    let webhookGets = 0;
    let serverEnabled = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        webhookGets += 1;
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook(serverEnabled)] } }));
      }
      if (url.endsWith('/webhooks/hook-1/enabled') && method === 'PUT') {
        const request = deferred<Response>();
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        toggles.push({ request, enabled: body.enabled });
        return request.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(ConnectionsPage));
    await settle(20);
    const toggle = view.host.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    clickSameTick(toggle as HTMLButtonElement, 1); // intent 1: true
    await settle(5);
    clickSameTick(toggle as HTMLButtonElement, 1); // intent 2: false (latest)
    await settle(5);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    serverEnabled = toggles[0]?.enabled ?? false;
    toggles[0]?.request.resolve(json({ ok: true }));
    await settle(10);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true, false]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(1);

    serverEnabled = toggles[1]?.enabled ?? true;
    toggles[1]?.request.resolve(json({ ok: true }));
    await settle(20);
    expect(serverEnabled).toBe(false);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(2);
    view.unmount();
  });
});
