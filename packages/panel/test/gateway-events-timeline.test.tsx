import { Events } from '../src/pages/control/gateway/Events';
import { MAX_NAME, MAX_VIEWS, SAVED_VIEWS_KEY } from '../src/pages/control/gateway/useSavedViews';
import { at, delivery, route, serveGateway, stats } from './gateway.helpers';
import {
  act,
  buttonByText,
  clickSameTick,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  setInput,
  settle,
  test,
  useConnectionStore,
} from './server-action-pages.helpers';

installTestHooks();

const EVENTS = '/events-gateway/events';
const statsReads = (seen: readonly string[]) =>
  seen.filter((call) => call.includes('/webhooks/stats'));
const strip = (host: HTMLElement) =>
  host.querySelector('[role="img"][aria-label^="Events over time"]');
const bars = (host: HTMLElement) => host.querySelectorAll('[data-bucket]');
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);
const select = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const choose = (element: HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
const nameInput = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('input[aria-label="View name"]')!;
const stored = (): unknown => JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? 'null');
const view = (name: string, over: Record<string, string> = {}) => ({
  name,
  route: 'hook-1',
  status: 'failed',
  range: '7d',
  ...over,
});

const clean = () => localStorage.removeItem(SAVED_VIEWS_KEY);

describe('Events timeline', () => {
  test('draws one bar for each slice of the stats read and says the totals in words', async () => {
    serveGateway([route()], [delivery()]);
    const page = at(EVENTS, createElement(Events));
    await settle(20);
    expect(bars(page.host)).toHaveLength(24);
    expect(strip(page.host)?.getAttribute('aria-label')).toContain(
      '8 successful, 2 failed, 1 pending'
    );
    page.unmount();
  });

  test('a range with no events says so and draws no bars', async () => {
    const quiet = stats({
      delivered: 0,
      failed: 0,
      pending: 0,
      buckets: stats().buckets.map((bucket) => ({
        ...bucket,
        delivered: 0,
        failed: 0,
        pending: 0,
      })),
    });
    serveGateway([route()], [], quiet);
    const page = at(EVENTS, createElement(Events));
    await settle(20);
    expect(page.host.textContent).toContain('No events in this range');
    expect(bars(page.host)).toHaveLength(0);
    page.unmount();
  });

  test('it reads the connection and the range the list shows', async () => {
    const calls = serveGateway([route()], [delivery()]);
    const page = at(`${EVENTS}?route=hook-1&range=7d`, createElement(Events));
    await settle(20);
    const query = new URL(statsReads(calls.seen)[0]!.split(' ')[1]!, 'http://x').searchParams;
    expect(query.get('webhook')).toBe('hook-1');
    expect(Number(query.get('until')) - Number(query.get('since'))).toBe(7 * 86_400_000);
    page.unmount();
  });

  test('a filter change reads it again, and the minute poll does not', async () => {
    useConnectionStore.setState({ refreshMs: 40 });
    const calls = serveGateway([route()], [delivery()]);
    const page = at(EVENTS, createElement(Events));
    await settle(250);
    // The feed was polled several times; the strip was read once.
    expect(calls.feed.length).toBeGreaterThan(2);
    expect(statsReads(calls.seen)).toHaveLength(1);
    choose(select(page.host, 'Time range'), '6h');
    await settle(20);
    expect(statsReads(calls.seen)).toHaveLength(2);
    page.unmount();
  });

  test('a strip that cannot be read says so and the list still works', async () => {
    serveGateway([route()], [delivery()]);
    const served = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/webhooks/stats')
        ? Promise.resolve(json({ ok: false, error: 'stats are down' }, 500))
        : served(input, init)) as typeof fetch;
    const page = at(EVENTS, createElement(Events));
    await settle(30);
    expect(page.host.textContent).toContain('Timeline unavailable');
    expect(page.host.textContent).toContain('job-9');
    page.unmount();
  });

  test('Refresh reads the feed and the strip once however fast it is pressed', async () => {
    const calls = serveGateway([route()], [delivery()]);
    const page = at(EVENTS, createElement(Events));
    await settle(20);
    const feed = calls.feed.length;
    const timeline = statsReads(calls.seen).length;
    clickSameTick(buttonByText(page.host, 'Refresh'), 3);
    await settle(30);
    expect(calls.feed.length).toBe(feed + 1);
    expect(statsReads(calls.seen)).toHaveLength(timeline + 1);
    page.unmount();
  });
});

describe('Saved views', () => {
  test('Save view keeps the route, status and range under the name, and the name is then the chosen view', async () => {
    clean();
    serveGateway([route()], [delivery()]);
    const page = at(`${EVENTS}?route=hook-1&status=failed&range=7d`, createElement(Events));
    await settle(20);
    expect(hasButton(page.host, 'Save view')).toBe(true);
    expect(buttonByText(page.host, 'Save view').disabled).toBe(true);
    setInput(nameInput(page.host), '  Billing failures ');
    act(() => buttonByText(page.host, 'Save view').click());
    expect(stored()).toEqual([view('Billing failures')]);
    expect(select(page.host, 'Saved views').value).toBe('Billing failures');
    expect(hasButton(page.host, 'Delete view')).toBe(true);
    expect(hasButton(page.host, 'Save view')).toBe(false);
    page.unmount();

    // A reload keeps it.
    serveGateway([route()], [delivery()]);
    const again = at(EVENTS, createElement(Events));
    await settle(20);
    expect([...select(again.host, 'Saved views').options].map((o) => o.value)).toContain(
      'Billing failures'
    );
    again.unmount();
    clean();
  });

  test('choosing a view applies its filters to the address and so to the reads', async () => {
    clean();
    localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([
        view('Billing failures'),
        view('Other', { status: 'all', range: '24h', route: '' }),
      ])
    );
    const calls = serveGateway([route()], [delivery()]);
    const page = at(EVENTS, createElement(Events));
    await settle(20);
    choose(select(page.host, 'Saved views'), 'Billing failures');
    await settle(20);
    const last = calls.feed.at(-1)!;
    expect(last.get('webhook')).toBe('hook-1');
    expect(last.get('status')).toBe('failed');
    expect(Math.abs(Date.now() - Number(last.get('since')) - 7 * 86_400_000)).toBeLessThan(60_000);
    expect(select(page.host, 'Connection').value).toBe('hook-1');
    expect(select(page.host, 'Time range').value).toBe('7d');
    page.unmount();
    clean();
  });

  test('Delete view removes it from the list and from storage', async () => {
    clean();
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify([view('Billing failures'), view('Keep')]));
    serveGateway([route()], [delivery()]);
    const page = at(`${EVENTS}?route=hook-1&status=failed&range=7d`, createElement(Events));
    await settle(20);
    act(() => buttonByText(page.host, 'Delete view').click());
    expect(stored()).toEqual([view('Keep')]);
    expect([...select(page.host, 'Saved views').options].map((o) => o.value)).not.toContain(
      'Billing failures'
    );
    page.unmount();
    clean();
  });

  test('a name is cut to 40 characters and the same name replaces its view', async () => {
    clean();
    serveGateway([route()], [delivery()]);
    const page = at(`${EVENTS}?route=hook-1`, createElement(Events));
    await settle(20);
    setInput(nameInput(page.host), 'x'.repeat(MAX_NAME + 10));
    act(() => buttonByText(page.host, 'Save view').click());
    expect((stored() as Array<{ name: string }>)[0]!.name).toHaveLength(MAX_NAME);
    page.unmount();
    clean();

    serveGateway([route()], [delivery()]);
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify([view('Same', { route: '' })]));
    const second = at(`${EVENTS}?route=hook-1&status=failed`, createElement(Events));
    await settle(20);
    setInput(nameInput(second.host), 'Same');
    act(() => buttonByText(second.host, 'Save view').click());
    expect(stored()).toEqual([view('Same', { range: '24h' })]);
    second.unmount();
    clean();
  });

  test('at most 20 views: the 21st cannot be saved, and the page says why', async () => {
    clean();
    localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify(
        Array.from({ length: MAX_VIEWS }, (_, n) =>
          view(`View ${n}`, { range: '1h', status: String(n) })
        )
      )
    );
    serveGateway([route()], [delivery()]);
    const page = at(`${EVENTS}?route=hook-1`, createElement(Events));
    await settle(20);
    setInput(nameInput(page.host), 'One too many');
    expect(buttonByText(page.host, 'Save view').disabled).toBe(true);
    expect(page.host.textContent).toContain(`${MAX_VIEWS} views are saved`);
    page.unmount();
    clean();
  });

  test('storage that throws leaves the screen working, with Save disabled and a line saying why', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage denied');
      },
    });
    try {
      serveGateway([route()], [delivery()]);
      const page = at(`${EVENTS}?route=hook-1`, createElement(Events));
      await settle(20);
      expect(page.host.textContent).toContain('job-9');
      setInput(nameInput(page.host), 'Anything');
      expect(buttonByText(page.host, 'Save view').disabled).toBe(true);
      expect(page.host.textContent).toContain('This browser blocks storage');
      page.unmount();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  test('stored text that is not a list of views is ignored, not trusted', async () => {
    localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([{ name: 5 }, 'x', view('Good'), { name: 'No range' }])
    );
    serveGateway([route()], [delivery()]);
    const page = at(EVENTS, createElement(Events));
    await settle(20);
    expect(
      [...select(page.host, 'Saved views').options].map((o) => o.value).filter(Boolean)
    ).toEqual(['Good']);
    page.unmount();
    clean();
  });
});
