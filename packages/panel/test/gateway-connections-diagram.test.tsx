import { Fragment } from 'react';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Connections } from '../src/pages/control/gateway/Connections';
import {
  answer,
  asking,
  at,
  groupStat,
  menuItem,
  openMenu,
  route,
  serveGateway,
} from './gateway.helpers';
import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const HOME = '/events-gateway';
const page = () =>
  createElement(Fragment, null, createElement(Connections), createElement(ConfirmDialog));
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('section li')];
const poll = async () => {
  act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await settle(30);
};

const FOUR = () => [
  route({ id: 'a' }),
  route({ id: 'b', url: 'https://receiver.test/b', enabled: false, pausedBy: 'operator' }),
  route({ id: 'c', url: 'https://receiver.test/c', enabled: false, pausedBy: 'failures' }),
  route({ id: 'd', url: 'https://receiver.test/d', enabled: false }),
];

describe('Connections as a line diagram', () => {
  test('every connection is drawn once, and its state is a word, a glyph and a line pattern', async () => {
    serveGateway(FOUR());
    const view = at(HOME, page());
    await settle(20);
    const lines = rows(view.host);
    expect(lines).toHaveLength(4);
    const states = lines.map((li) => ({
      label: li.querySelector('a[aria-label]')?.getAttribute('aria-label'),
      glyph: li.querySelectorAll('a svg').length,
      wire: li.querySelector('[data-wire]')?.getAttribute('data-wire'),
    }));
    expect(states).toEqual([
      { label: 'https://receiver.test/hook, Active', glyph: 1, wire: 'solid' },
      { label: 'https://receiver.test/b, Paused', glyph: 1, wire: 'dashed' },
      { label: 'https://receiver.test/c, Paused after failures', glyph: 1, wire: 'dashed' },
      { label: 'https://receiver.test/d, Disabled', glyph: 1, wire: 'dotted' },
    ]);
    view.unmount();
  });

  test('a row has the switch and the menu, and the menu holds only what the list always had', async () => {
    serveGateway([route()]);
    const view = at(HOME, page());
    await settle(20);
    const [line] = rows(view.host);
    expect(
      [...line!.querySelectorAll('button')].map(
        (b) => b.getAttribute('role') ?? b.getAttribute('aria-haspopup')
      )
    ).toEqual(['switch', 'menu']);
    expect(line!.querySelectorAll('a')).toHaveLength(1);
    const menu = openMenu(view.host, 'https://receiver.test/hook');
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(labels).toEqual(['Open', 'Events', 'Send a test event', 'Remove connection']);
    // Nothing that shared/flowOperationPolicy.ts gates off on a generic surface.
    expect(labels.join(' ')).not.toMatch(
      /retry|cancel|discard|purge|clean|drain|obliterate|requeue/i
    );
    view.unmount();
  });

  test('Remove asks in the page: Escape sends nothing, the main button sends the same call as before', async () => {
    const calls = serveGateway([route()]);
    const view = at(HOME, page());
    await settle(20);
    const remove = menuItem(openMenu(view.host, 'https://receiver.test/hook'), 'Remove connection');
    act(() => remove.click());
    await settle(5);
    expect(asking()?.danger).toBe(true);
    expect(asking()?.confirmLabel).toBe('Remove connection');
    act(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(20);
    expect(asking()).toBeNull();
    expect(calls.seen.some((call) => call.startsWith('DELETE'))).toBe(false);

    const again = menuItem(openMenu(view.host, 'https://receiver.test/hook'), 'Remove connection');
    act(() => again.click());
    await settle(5);
    answer(true);
    await settle(20);
    expect(calls.seen.filter((call) => call.startsWith('DELETE'))).toEqual([
      'DELETE /webhooks/hook-1',
    ]);
    view.unmount();
  });

  test('the first load rises in turn; the cap of 8 lives in the style sheet', async () => {
    serveGateway(
      Array.from({ length: 10 }, (_, i) =>
        route({ id: `r${i}`, url: `https://receiver.test/${i}` })
      )
    );
    const view = at(HOME, page());
    await settle(20);
    const lines = rows(view.host);
    expect(lines.map((li) => li.classList.contains('motion-arrive'))).toEqual(Array(10).fill(true));
    expect(lines.map((li) => li.style.getPropertyValue('--i'))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i))
    );
    const css = await Bun.file(new URL('../src/motion.css', import.meta.url)).text();
    expect(css).toContain('animation-delay: calc(min(var(--i, 0), 8) * var(--dur-stagger))');
    view.unmount();
  });

  test('a poll that changes nothing restarts nothing, and a connection a poll adds just appears', async () => {
    serveGateway(FOUR(), [], undefined, [groupStat({ webhookId: 'a' })]);
    const view = at(HOME, page());
    await settle(20);
    const before = rows(view.host);
    await poll();
    const same = rows(view.host);
    expect(same).toHaveLength(4);
    expect(same.every((li, i) => li === before[i])).toBe(true);
    expect(same.every((li) => li.classList.contains('motion-arrive'))).toBe(true);
    expect(view.host.querySelectorAll('.motion-flash, .motion-comet')).toHaveLength(0);

    serveGateway([...FOUR(), route({ id: 'e', url: 'https://receiver.test/e' })], [], undefined, [
      groupStat({ webhookId: 'a' }),
    ]);
    await poll();
    const grown = rows(view.host);
    expect(grown).toHaveLength(5);
    expect(grown[4]!.classList.contains('motion-arrive')).toBe(false);
    view.unmount();
  });

  test('a poll that raises one count washes that figure only, and a rise in successes sends one comet down that line', async () => {
    serveGateway(
      [
        route({ id: 'a', successCount: 3 }),
        route({ id: 'b', url: 'https://receiver.test/b', successCount: 5 }),
      ],
      [],
      undefined,
      [groupStat({ webhookId: 'a' }), groupStat({ webhookId: 'b' })]
    );
    const view = at(HOME, page());
    await settle(20);
    expect(view.host.querySelectorAll('.motion-flash, .motion-comet')).toHaveLength(0);

    serveGateway(
      [
        route({ id: 'a', successCount: 4 }),
        route({ id: 'b', url: 'https://receiver.test/b', successCount: 5 }),
      ],
      [],
      undefined,
      [groupStat({ webhookId: 'a', delivered: 9 }), groupStat({ webhookId: 'b' })]
    );
    await poll();
    const washed = [...view.host.querySelectorAll('.motion-flash')];
    expect(washed.map((el) => el.textContent)).toEqual(['9']);
    const [first, second] = rows(view.host);
    expect(first!.querySelectorAll('.motion-comet')).toHaveLength(1);
    expect(second!.querySelectorAll('.motion-comet')).toHaveLength(0);

    // The same read again keeps the very same comet node: it is not sent twice.
    const comet = first!.querySelector('.motion-comet');
    await poll();
    expect(first!.querySelector('.motion-comet')).toBe(comet);

    // A fall is not traffic: no new comet.
    serveGateway(
      [
        route({ id: 'a', successCount: 2 }),
        route({ id: 'b', url: 'https://receiver.test/b', successCount: 5 }),
      ],
      [],
      undefined,
      [groupStat({ webhookId: 'a', delivered: 9 }), groupStat({ webhookId: 'b' })]
    );
    await poll();
    expect(first!.querySelector('.motion-comet')).toBe(comet);
    view.unmount();
  });

  test('the hover card lists the rules and the fixed ones with their numbers, and Open goes to the connection', async () => {
    serveGateway([route({ filter: { queue: 'emails' } })]);
    const view = at(HOME, page());
    await settle(20);
    const pill = view.host.querySelector<HTMLAnchorElement>('section li a[aria-label]')!;
    act(() => pill.focus());
    const card = view.host.querySelector('[role="group"]');
    expect(card?.textContent).toContain('Retry, 8 attempts');
    expect(card?.textContent).toContain('Rate limit, 60 a minute');
    expect(card?.textContent).toContain('Auto-pause, after 20 failures');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe(
      '/events-gateway/connections/hook-1'
    );
    view.unmount();
  });

  test('under reduced motion the whole diagram is in the page at once, with nothing hidden to be revealed', async () => {
    const real = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      serveGateway(FOUR(), [], undefined, [groupStat({ webhookId: 'a' })]);
      const view = at(HOME, page());
      await settle(20);
      expect(rows(view.host)).toHaveLength(4);
      expect(view.host.querySelectorAll('[data-wire]')).toHaveLength(4);
      expect(view.host.querySelector('section li')?.textContent).toContain('8 successful');
      for (const el of view.host.querySelectorAll<HTMLElement>('section *')) {
        expect(el.style.opacity).toBe('');
        expect(el.style.visibility).toBe('');
      }
      // A menu opens and closes without an exit to wait for.
      const menu = openMenu(view.host, 'https://receiver.test/hook');
      expect(menu).not.toBeNull();
      act(() => {
        document.activeElement?.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(view.host.querySelector('[role="menu"]')).toBeNull();
      view.unmount();
    } finally {
      window.matchMedia = real;
    }
  });
});
