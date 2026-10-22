import { address, answerAdd, field, page, posts } from './gateway-create.helpers';
import { serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  describe,
  expect,
  installTestHooks,
  json,
  setInput,
  settle,
  test,
  useToastStore,
} from './server-action-pages.helpers';

installTestHooks();

describe('signing secret on the create page', () => {
  test('Generate fills a 64-character secret that is sent once and cleared after', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    const secret = field(view.host, 'webhook-secret');
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
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    expect(calls.bodies).toEqual([
      {
        url: 'https://receiver.test/hook',
        events: ['job.completed', 'job.failed'],
        secret: generated,
      },
    ]);
    // The page has moved on, and the secret is in no storage.
    expect(JSON.stringify({ ...localStorage })).not.toContain(generated);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(generated);
    view.unmount();
  });

  test('a secret that is too short is refused before anything is sent', async () => {
    const calls = serveGateway([]);
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/h');
    setInput(field(view.host, 'webhook-secret'), 'short');
    await settle(5);
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(10);
    expect(view.host.textContent).toContain('Secret must be 16 to 256 characters');
    expect(posts(calls)).toEqual([]);
    view.unmount();
  });

  test('a connection to another queue has no secret field', async () => {
    serveGateway([]);
    const view = page();
    await settle(10);
    act(() => buttonByText(view.host, 'Another queue').click());
    expect(view.host.querySelector('input[name="webhook-secret"]')).toBeNull();
    view.unmount();
  });

  test('a secret the store made is shown once on the page, never stored, and Open connection goes on', async () => {
    serveGateway([]);
    const made = 'made-by-the-store-0123456789abcdef';
    answerAdd(json({ ok: true, data: { webhook: { id: 'new-1' }, secret: made } }, 201));
    const view = page();
    await settle(10);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    act(() => buttonByText(view.host, 'Add connection').click());
    await settle(20);
    // The page waits for the secret to be copied, and cannot add the connection a second time.
    expect(address()).toBe('/events-gateway/connections/new');
    expect(view.host.textContent).toContain(made);
    expect(view.host.querySelector('input[name="webhook-url"]')).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain(made);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(made);
    expect(JSON.stringify(useToastStore.getState())).not.toContain(made);
    act(() => buttonByText(view.host, 'Open connection').click());
    await settle(10);
    expect(address()).toBe('/events-gateway/connections/new-1');
    expect(view.host.textContent).not.toContain(made);
    view.unmount();
  });
});
