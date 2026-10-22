import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { Events } from '../src/pages/control/gateway/Events';
import { at, delivery, route, serveGateway } from './gateway.helpers';
import {
  act,
  buttonByText,
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const EVENTS = '/events-gateway/events';
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('tbody tr')];
const place = (row: HTMLElement) => row.style.getPropertyValue('--i');
const opener = (host: HTMLElement, job: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Open event emails / ${job}"]`)!;
const poll = async () => {
  act(() => document.dispatchEvent(new window.Event('visibilitychange')));
  await settle(30);
};
// happy-dom is 1024 wide, so the detail is a sheet; this makes the window as wide as the side column needs.
const wide = () => {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width'),
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = real;
  };
};
const three = () => [
  delivery({ id: '3', jobId: 'job-3' }),
  delivery({ id: '2', jobId: 'job-2' }),
  delivery({ id: '1', jobId: 'job-1' }),
];

describe('Events screen: rows arrive', () => {
  test('the first load rises in a stagger, and a poll of the same events leaves every row alone', async () => {
    serveGateway([route()], three());
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    const first = rows(view.host);
    expect(first.map((row) => row.classList.contains('motion-arrive'))).toEqual([true, true, true]);
    expect(first.map(place)).toEqual(['0', '1', '2']);
    await poll();
    const again = rows(view.host);
    expect(again.every((row, i) => row === first[i])).toBe(true);
    expect(again.map(place)).toEqual(['0', '1', '2']);
    view.unmount();
  });

  test('an event a poll adds rises once at the front, and the rows that were there stay the same nodes', async () => {
    const feed = three();
    serveGateway([route()], feed);
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    const before = rows(view.host);
    feed.unshift(delivery({ id: '4', jobId: 'job-4' }));
    await poll();
    const after = rows(view.host);
    expect(after).toHaveLength(4);
    expect(after[0].textContent).toContain('job-4');
    expect(after[0].classList.contains('motion-arrive')).toBe(true);
    expect(place(after[0])).toBe('0');
    expect(after.slice(1).every((row, i) => row === before[i])).toBe(true);
    view.unmount();
  });

  test('another filter just appears: its rows do not rise as if they were new', async () => {
    const feed = [
      delivery({ id: '2', jobId: 'job-2' }),
      delivery({ id: '1', jobId: 'job-1', status: 'delivered' }),
    ];
    serveGateway([route()], feed);
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    act(() => buttonByText(view.host, 'Failed').click());
    await settle(30);
    expect(rows(view.host)).toHaveLength(1);
    expect(rows(view.host)[0].classList.contains('motion-arrive')).toBe(false);
    view.unmount();
  });
});

describe('Events screen: the event under 1280 px is a sheet', () => {
  test('a row opens a dialog that owns the shell; Escape closes it and focus goes back to the row', async () => {
    serveGateway([route()], three());
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    const button = opener(view.host, 'job-2');
    act(() => button.focus());
    act(() => button.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Event"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('section[aria-label="Event details"]')).not.toBeNull();
    expect(useGlobalModalStore.getState().active).toBe('event-sheet');
    act(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(60);
    await settle(260);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useGlobalModalStore.getState().active).toBeNull();
    expect(document.activeElement).toBe(button);
    view.unmount();
  });

  test('the scrim and the Close button inside both close it', async () => {
    serveGateway([route()], three());
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    act(() => opener(view.host, 'job-2').click());
    act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close event"]')!.click()
    );
    await settle(60);
    await settle(260);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => opener(view.host, 'job-2').click());
    act(() => buttonByText(document.body, 'Close').click());
    await settle(60);
    await settle(260);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    view.unmount();
  });

  test('at 1280 px and over the detail stays a column beside the table, with no dialog and no claim', async () => {
    const restore = wide();
    try {
      serveGateway([route()], three());
      const view = at(EVENTS, createElement(Events));
      await settle(20);
      act(() => opener(view.host, 'job-2').click());
      expect(view.host.querySelector('section[aria-label="Event details"]')).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(useGlobalModalStore.getState().active).toBeNull();
      view.unmount();
    } finally {
      restore();
    }
  });

  test('under reduced motion the sheet is gone the moment it closes', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      serveGateway([route()], three());
      const view = at(EVENTS, createElement(Events));
      await settle(20);
      act(() => opener(view.host, 'job-2').click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      act(() => buttonByText(document.body, 'Close').click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      view.unmount();
    } finally {
      window.matchMedia = real;
    }
  });
});

describe('Events screen: the attempts line', () => {
  test('lists the attempts oldest first, each in words, ending in how the event stands', async () => {
    serveGateway([route()], [delivery()]);
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    act(() => opener(view.host, 'job-9').click());
    const line = document.querySelector('ol[aria-label="Attempts, oldest first"]')!;
    const stops = [...line.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(stops).toHaveLength(3);
    expect(stops[0]).toContain('Attempt 1');
    expect(stops[0]).toContain('Failed');
    expect(stops[0]).toContain('took 12ms');
    expect(stops[0]).toContain('HTTP 502');
    expect(stops[0]).toContain('receiver answered 502');
    expect(stops[1]).toContain('Attempt 2');
    expect(stops[1]).toContain('receiver answered 503');
    expect(stops[2]).toContain('Failed');
    expect([...line.querySelectorAll('li')].map((li) => li.style.getPropertyValue('--i'))).toEqual([
      '0',
      '1',
      '2',
    ]);
    view.unmount();
  });

  test('an attempt that got a good answer says Sent, and one with no answer says so', async () => {
    serveGateway(
      [route()],
      [
        delivery({
          status: 'delivered',
          lastError: null,
          history: [
            { attempt: 1, at: 1000, durationMs: 30, statusCode: null, error: 'connection reset' },
            { attempt: 2, at: 1500, durationMs: 9, statusCode: 200, error: null },
          ],
        }),
      ]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    act(() => opener(view.host, 'job-9').click());
    const stops = [...document.querySelectorAll('ol[aria-label="Attempts, oldest first"] li')].map(
      (li) => li.textContent ?? ''
    );
    expect(stops[0]).toContain('HTTP no answer');
    expect(stops[0]).toContain('connection reset');
    expect(stops[1]).toContain('Sent');
    expect(stops[1]).toContain('HTTP 200');
    expect(stops[2]).toContain('Successful');
    view.unmount();
  });

  test('an event held by a switched-off connection ends in On hold', async () => {
    serveGateway(
      [route({ enabled: false })],
      [delivery({ status: 'pending', lastError: null, finishedAt: null })]
    );
    const view = at(EVENTS, createElement(Events));
    await settle(20);
    act(() => opener(view.host, 'job-9').click());
    const stops = [...document.querySelectorAll('ol[aria-label="Attempts, oldest first"] li')].map(
      (li) => li.textContent ?? ''
    );
    expect(stops).toHaveLength(3);
    expect(stops[2]).toBe('On hold');
    view.unmount();
  });
});
