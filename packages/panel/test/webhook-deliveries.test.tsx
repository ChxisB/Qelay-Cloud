import {
  act,
  buttonByText,
  clickSameTick,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  render,
  setInput,
  settle,
  test,
  Webhooks,
} from './server-action-pages.helpers';

installTestHooks();

const webhook = (over: Record<string, unknown> = {}) => ({
  id: 'hook-1',
  url: 'https://receiver.test/hook',
  urlRedacted: false,
  events: ['job.failed'],
  queue: null,
  signed: true,
  enabled: true,
  createdAt: 1_000,
  lastTriggered: null,
  successCount: 0,
  failureCount: 1,
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  id: '2',
  webhookId: 'hook-1',
  event: 'job.failed',
  queue: 'emails',
  jobId: 'job-9',
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

interface Calls {
  readonly seen: string[];
  readonly bodies: unknown[];
}

/** A server with one webhook and the deliveries given; every call is recorded as `METHOD path`. */
function serve(hooks: unknown[], deliveries: unknown[]): Calls {
  const calls: Calls = { seen: [], bodies: [] };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.seen.push(`${method} ${url.pathname}${url.search}`);
    if (init?.body !== undefined) calls.bodies.push(JSON.parse(String(init.body)));
    if (url.pathname === '/webhooks' && method === 'GET') {
      return Promise.resolve(json({ ok: true, data: { webhooks: hooks } }));
    }
    if (url.pathname === '/webhooks' && method === 'POST')
      return Promise.resolve(json({ ok: true }));
    if (url.pathname === '/webhooks/hook-1/deliveries' && method === 'GET') {
      const status = url.searchParams.get('status');
      const rows = deliveries.filter((row) => status === null || (row as any).status === status);
      return Promise.resolve(json({ ok: true, data: { deliveries: rows, next: null } }));
    }
    if (method === 'POST') return Promise.resolve(json({ ok: true, data: {} }, 202));
    return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
  }) as typeof fetch;
  return calls;
}

const open = async (view: ReturnType<typeof render>) => {
  const toggle = view.host.querySelector<HTMLButtonElement>('button[aria-label="Show deliveries"]');
  expect(toggle).not.toBeNull();
  act(() => toggle!.click());
  await settle(20);
};

describe('webhook delivery history', () => {
  test('shows status, attempts and the last error, and says whether the webhook is signed', async () => {
    serve([webhook()], [delivery(), delivery({ id: '1', status: 'delivered', lastError: null })]);
    const view = render(createElement(Webhooks));
    await settle(20);
    expect(view.host.textContent).toContain('signed');
    await open(view);
    const text = view.host.textContent ?? '';
    expect(text).toContain('failed');
    expect(text).toContain('delivered');
    expect(text).toContain('receiver answered 503');
    expect(text).toContain('#1 502 · #2 503');
    view.unmount();
  });

  test('a failed delivery is retried once, however fast the button is pressed, and the page refreshes', async () => {
    const calls = serve([webhook()], [delivery()]);
    const view = render(createElement(Webhooks));
    await settle(20);
    await open(view);
    const retry = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry delivery 2"]'
    );
    expect(retry).not.toBeNull();
    const before = calls.seen.filter((call) => call.includes('/deliveries?')).length;
    clickSameTick(retry!);
    await settle(20);
    expect(
      calls.seen.filter((call) => call === 'POST /webhooks/hook-1/deliveries/2/retry')
    ).toHaveLength(1);
    expect(calls.seen.filter((call) => call.includes('/deliveries?')).length).toBeGreaterThan(
      before
    );
    view.unmount();
  });

  test('a delivery that is not failed has no retry button', async () => {
    serve([webhook()], [delivery({ status: 'pending', lastError: null, history: [] })]);
    const view = render(createElement(Webhooks));
    await settle(20);
    await open(view);
    expect(view.host.querySelector('button[aria-label^="Retry delivery"]')).toBeNull();
    view.unmount();
  });

  test('the status filter asks the server for that status', async () => {
    const calls = serve([webhook()], [delivery(), delivery({ id: '1', status: 'delivered' })]);
    const view = render(createElement(Webhooks));
    await settle(20);
    await open(view);
    act(() => buttonByText(view.host, 'Failed').click());
    await settle(20);
    expect(calls.seen).toContain('GET /webhooks/hook-1/deliveries?limit=10&status=failed');
    view.unmount();
  });

  test('a test event is sent for an enabled webhook and refused in the UI for a disabled one', async () => {
    const calls = serve([webhook()], []);
    const view = render(createElement(Webhooks));
    await settle(20);
    await open(view);
    act(() => buttonByText(view.host, 'Send test event').click());
    await settle(20);
    expect(calls.seen).toContain('POST /webhooks/hook-1/test');
    view.unmount();

    serve([webhook({ enabled: false })], []);
    const off = render(createElement(Webhooks));
    await settle(20);
    await open(off);
    expect(buttonByText(off.host, 'Send test event').disabled).toBe(true);
    off.unmount();
  });
});

describe('webhook signing secret', () => {
  test('Generate fills a 64-character secret that is sent once and cleared after', async () => {
    const calls = serve([], []);
    const view = render(createElement(Webhooks));
    await settle(20);
    const url = view.host.querySelector<HTMLInputElement>('input[name="webhook-url"]')!;
    setInput(url, 'https://receiver.test/hook');
    const secret = view.host.querySelector<HTMLInputElement>('input[name="webhook-secret"]')!;
    expect(secret.type).toBe('password');
    act(() =>
      view.host
        .querySelector<HTMLButtonElement>('button[aria-label="Generate a signing secret"]')!
        .click()
    );
    expect(secret.value).toMatch(/^[0-9a-f]{64}$/u);
    // Shown while it is being created, so it can be copied to the receiver.
    expect(secret.type).toBe('text');
    const generated = secret.value;
    act(() => buttonByText(view.host, 'Add webhook').click());
    await settle(20);
    expect(calls.bodies).toEqual([
      {
        url: 'https://receiver.test/hook',
        events: ['job.completed', 'job.failed'],
        secret: generated,
      },
    ]);
    expect(secret.value).toBe('');
    expect(secret.type).toBe('password');
    view.unmount();
  });

  test('a secret that is too short is refused before anything is sent', async () => {
    const calls = serve([], []);
    const view = render(createElement(Webhooks));
    await settle(20);
    setInput(
      view.host.querySelector<HTMLInputElement>('input[name="webhook-url"]')!,
      'https://receiver.test/h'
    );
    setInput(view.host.querySelector<HTMLInputElement>('input[name="webhook-secret"]')!, 'short');
    await settle(5);
    act(() => buttonByText(view.host, 'Add webhook').click());
    await settle(10);
    expect(view.host.textContent).toContain('Secret must be 16 to 256 characters');
    expect(calls.seen.filter((call) => call.startsWith('POST'))).toEqual([]);
    view.unmount();
  });

  test('the list never shows a secret: only whether deliveries are signed', async () => {
    serve([webhook({ signed: false, urlRedacted: true, url: 'https://receiver.test/' })], []);
    const view = render(createElement(Webhooks));
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('unsigned');
    expect(text).toContain('path hidden');
    view.unmount();
  });
});
