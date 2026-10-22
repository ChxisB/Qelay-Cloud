import { alertOf, answerAdd, field, page, posts, stepOf } from './gateway-create.helpers';
import { field as byLabel, serve, two } from './gateway-destinations.helpers';
import { type } from './gateway.helpers';
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
} from './server-action-pages.helpers';

installTestHooks();

const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);

/** Picks an option of the saved-destination select, the way a person would. */
function choose(host: HTMLElement, id: string) {
  const select = host.querySelector<HTMLSelectElement>('select[name="route-destination"]')!;
  act(() => {
    select.value = id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const use = (host: HTMLElement) => act(() => buttonByText(host, 'Saved destination').click());
const save = (host: HTMLElement) => act(() => buttonByText(host, 'Add connection').click());

describe('New connection: saved destinations', () => {
  test('a server with none to choose from offers only an address or a queue', async () => {
    serve([]);
    const view = page();
    await settle(20);
    expect(hasButton(view.host, 'Saved destination')).toBe(false);
    expect(hasButton(view.host, 'Webhook address')).toBe(true);
    view.unmount();
  });

  test('a server that predates them offers only an address or a queue', async () => {
    serve();
    const view = page();
    await settle(20);
    expect(hasButton(view.host, 'Saved destination')).toBe(false);
    view.unmount();
  });

  test('a saved destination is chosen by name, its address is shown, and only its id is sent', async () => {
    const calls = serve(two());
    const view = page();
    await settle(20);
    use(view.host);
    expect(stepOf(view.host.querySelector('select[name="route-destination"]'))).toBe('Destination');
    expect(view.host.querySelector('input[name="webhook-url"]')).toBeNull();
    choose(view.host, 'dest-1');
    expect(view.host.textContent).toContain('https://billing.test/hook');
    save(view.host);
    await settle(30);
    expect(calls.bodies).toEqual([
      { destinationId: 'dest-1', events: ['job.completed', 'job.failed'] },
    ]);
    view.unmount();
  });

  test('a saved queue destination needs the source queue, and has no signing secret', async () => {
    const calls = serve(two());
    const view = page();
    await settle(20);
    expect(view.host.querySelector('input[name="webhook-secret"]')).not.toBeNull();
    use(view.host);
    choose(view.host, 'dest-2');
    expect(view.host.querySelector('input[name="webhook-secret"]')).toBeNull();
    save(view.host);
    await settle(10);
    expect(posts(calls)).toEqual([]);
    expect(alertOf(view.host)?.textContent).toContain('A source queue');
    setInput(field(view.host, 'webhook-queue'), 'orders');
    save(view.host);
    await settle(30);
    expect(calls.bodies).toEqual([
      { destinationId: 'dest-2', queue: 'orders', events: ['job.completed', 'job.failed'] },
    ]);
    view.unmount();
  });

  test('saving with no destination chosen says so at the destination', async () => {
    const calls = serve(two());
    const view = page();
    await settle(20);
    use(view.host);
    save(view.host);
    await settle(10);
    expect(posts(calls)).toEqual([]);
    expect(alertOf(view.host)?.textContent).toBe('Choose a saved destination.');
    expect(stepOf(alertOf(view.host))).toBe('Destination');
    view.unmount();
  });

  test('a destination removed meanwhile is refused at the destination step', async () => {
    serve(two());
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' && new URL(String(input)).pathname === '/webhooks'
        ? Promise.resolve(
            json({ ok: false, error: { code: 'destination_not_found', message: 'gone' } }, 404)
          )
        : served(input, init)) as typeof fetch;
    const view = page();
    await settle(20);
    use(view.host);
    choose(view.host, 'dest-1');
    save(view.host);
    await settle(30);
    expect(stepOf(alertOf(view.host))).toBe('Destination');
    view.unmount();
  });
});

describe('New connection: name and rules', () => {
  test('a name, a description, a delay and a window are sent with the connection', async () => {
    const calls = serve([]);
    const view = page();
    await settle(20);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    type(byLabel(view.host, 'Name'), 'Billing');
    type(byLabel(view.host, 'Description'), 'Failed payments');
    type(byLabel(view.host, 'Delay'), '30');
    type(byLabel(view.host, 'Deduplicate within'), '600');
    save(view.host);
    await settle(30);
    expect(calls.bodies).toEqual([
      {
        url: 'https://receiver.test/hook',
        events: ['job.completed', 'job.failed'],
        name: 'Billing',
        description: 'Failed payments',
        delayMs: 30_000,
        dedupe: { windowMs: 600_000, fields: ['event', 'jobId'] },
      },
    ]);
    view.unmount();
  });

  test('a rule typed wrongly is refused beside its field, and nothing is sent', async () => {
    const calls = serve([]);
    const view = page();
    await settle(20);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    type(byLabel(view.host, 'Delay'), '7200');
    save(view.host);
    await settle(10);
    expect(posts(calls)).toEqual([]);
    expect(view.host.textContent).toContain('A delay is a number of seconds from 1 to 3,600.');
    view.unmount();
  });

  test('turning every event off is refused at the events', async () => {
    const calls = serve([]);
    const view = page();
    await settle(20);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    for (const event of ['job.completed', 'job.failed']) {
      act(() => buttonByText(view.host, event).click());
    }
    save(view.host);
    await settle(10);
    expect(posts(calls)).toEqual([]);
    expect(view.host.textContent).toContain('Send at least one event.');
    view.unmount();
  });

  test('a refusal that names a rule lands beside that rule, with everything typed kept', async () => {
    serve([]);
    answerAdd(
      json(
        {
          ok: false,
          error: {
            code: 'invalid_option',
            message: 'the filter is wrong',
            details: { option: 'filter' },
          },
        },
        400
      )
    );
    const view = page();
    await settle(20);
    setInput(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    type(byLabel(view.host, 'Filter'), '{ "queue": { "$nope": 1 } }');
    save(view.host);
    await settle(30);
    expect(view.host.textContent).toContain('The filter is wrong.');
    expect(byLabel(view.host, 'Filter').getAttribute('aria-invalid')).toBe('true');
    expect(alertOf(view.host)).toBeNull();
    expect(byLabel<HTMLTextAreaElement>(view.host, 'Filter').value).toContain('$nope');
    expect(field(view.host, 'webhook-url').value).toBe('https://receiver.test/hook');
    view.unmount();
  });
});
