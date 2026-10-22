import { field, refuse, type Row, screen, serve, two } from './gateway-destinations.helpers';
import { answer, asking, asViewer, destination } from './gateway.helpers';
import {
  act,
  buttonByText,
  describe,
  expect,
  installTestHooks,
  setInput,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);
const alerts = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="alert"]')].map((item) => item.textContent);

describe('Gateway destinations: reading', () => {
  test('an operator reads each destination with its address and how many connections use it', async () => {
    serve(two());
    const view = screen();
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Billing receiver');
    expect(text).toContain('https://billing.test/hook');
    expect(text).toContain('2 connections are made from it.');
    expect(text).toContain('Refunds');
    expect(text).toContain('1 connection is made from it.');
    expect(hasButton(view.host, 'Add destination')).toBe(true);
    expect(view.host.querySelectorAll('button').length).toBeGreaterThanOrEqual(5);
    view.unmount();
  });

  test('a viewer reads the list, sees the address is hidden, and has nothing to press', async () => {
    asViewer();
    serve([destination({ urlRedacted: true, url: 'https://billing.test' })]);
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('(address hidden for read-only access)');
    expect(hasButton(view.host, 'Add destination')).toBe(false);
    expect(hasButton(view.host, 'Edit')).toBe(false);
    expect(hasButton(view.host, 'Remove')).toBe(false);
    view.unmount();
  });

  test('a server that predates saved destinations says so instead of failing', async () => {
    serve();
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('Saved destinations are not available');
    expect(hasButton(view.host, 'Add destination')).toBe(false);
    view.unmount();
  });

  test('with none saved the page says what one is for', async () => {
    serve([]);
    const view = screen();
    await settle(20);
    expect(view.host.textContent).toContain('No saved destinations');
    view.unmount();
  });
});

describe('Gateway destinations: adding', () => {
  test('a destination is added with its name and address, and the list shows it', async () => {
    const calls = serve([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add destination').click());
    setInput(field(view.host, 'Name'), 'Billing receiver');
    setInput(field(view.host, 'URL'), 'https://billing.test/hook');
    act(() => buttonByText(view.host, 'Add destination').click());
    await settle(30);
    expect(calls.seen).toContain('POST /webhooks/destinations');
    expect(calls.bodies).toContainEqual({
      name: 'Billing receiver',
      kind: 'http',
      url: 'https://billing.test/hook',
    });
    expect(view.host.textContent).toContain('No connection is made from it yet.');
    await settle(260);
    expect(view.host.querySelector('form')).toBeNull();
    view.unmount();
  });

  test('an address that is not http or https is refused beside its field before anything is sent', async () => {
    const calls = serve([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add destination').click());
    setInput(field(view.host, 'Name'), 'Billing');
    // A browser lets an ftp:// address through its own url check; the form's rule is the one that refuses it.
    setInput(field(view.host, 'URL'), 'ftp://billing.test');
    act(() => buttonByText(view.host, 'Add destination').click());
    await settle(10);
    expect(calls.seen.filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(view.host.textContent).toContain('The URL must be a valid http:// or https:// address');
    view.unmount();
  });

  test('a name that is taken is shown beside the name and keeps what was typed', async () => {
    serve(two());
    refuse('POST', 409, 'destination_name_taken');
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add destination').click());
    setInput(field(view.host, 'Name'), 'Refunds');
    setInput(field(view.host, 'URL'), 'https://x.test/hook');
    act(() => buttonByText(view.host, 'Add destination').click());
    await settle(30);
    const name = field<HTMLInputElement>(view.host, 'Name');
    expect(name.value).toBe('Refunds');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(view.host.textContent).toContain('Destination name taken.');
    expect(alerts(view.host)).toEqual([]);
    view.unmount();
  });

  test('the limit is shown as a message of its own', async () => {
    serve([]);
    refuse('POST', 409, 'destination_limit', { limit: 100 });
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add destination').click());
    setInput(field(view.host, 'Name'), 'One more');
    setInput(field(view.host, 'URL'), 'https://x.test/hook');
    act(() => buttonByText(view.host, 'Add destination').click());
    await settle(30);
    expect(alerts(view.host)).toEqual(['Destination limit.']);
    view.unmount();
  });
});

describe('Gateway destinations: editing and removing', () => {
  const open = async (rows: Row[]) => {
    const calls = serve(rows);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Edit').click());
    return { calls, view };
  };

  test('a new address says how many connections it moves, and sends only the address', async () => {
    const { calls, view } = await open(two());
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    setInput(field(view.host, 'URL'), 'https://new.test/hook');
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain(
      'Saving changes 2 connections'
    );
    act(() => buttonByText(view.host, 'Save changes').click());
    await settle(30);
    expect(calls.seen).toContain('PATCH /webhooks/destinations/dest-1');
    expect(calls.bodies).toEqual([{ url: 'https://new.test/hook' }]);
    expect(view.host.textContent).toContain('https://new.test/hook');
    await settle(260);
    expect(view.host.querySelector('form')).toBeNull();
    view.unmount();
  });

  test('a save with nothing changed sends nothing and closes the form', async () => {
    const { calls, view } = await open(two());
    act(() => buttonByText(view.host, 'Save changes').click());
    await settle(10);
    expect(calls.seen.filter((call) => call.startsWith('PATCH'))).toEqual([]);
    await settle(260);
    expect(view.host.querySelector('form')).toBeNull();
    view.unmount();
  });

  test('Remove asks first, and a removed destination leaves the list', async () => {
    const calls = serve([destination({ connections: 0 })]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    expect(asking()?.question).toBe('Remove the destination "Billing receiver"?');
    answer(false);
    await settle(10);
    expect(calls.seen.filter((call) => call.startsWith('DELETE'))).toEqual([]);
    await settle(260);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    answer(true);
    await settle(30);
    expect(calls.seen).toContain('DELETE /webhooks/destinations/dest-1');
    expect(view.host.textContent).toContain('No saved destinations');
    view.unmount();
  });

  test('a destination in use is refused with how many connections use it', async () => {
    serve(two());
    refuse('DELETE', 409, 'destination_in_use', { connections: 2 });
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Remove').click());
    await settle(10);
    answer(true);
    await settle(30);
    const text = view.host.textContent ?? '';
    expect(text).toContain('"Billing receiver" was not removed');
    expect(text).toContain('2 connections are made from it. Remove or move them first.');
    expect(text).toContain('Refunds');
    view.unmount();
  });
});
