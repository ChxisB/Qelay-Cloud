import { Route, Routes } from 'react-router-dom';
import { ConnectionChain } from '../src/pages/control/gateway/ConnectionChain';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { FIXED_LABELS } from '../src/pages/control/gateway/connectionRules';
import { at, route, serveGateway } from './gateway.helpers';
import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  render,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const BASE = '/events-gateway/connections';
const RULES = 'ol[aria-label="Rules, in the order an event meets them"]';
const overview = () =>
  at(
    `${BASE}/hook-1`,
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: `${BASE}/:id`,
        element: createElement(ConnectionPage, { tab: 'overview' }),
      })
    )
  );
const poll = async () => {
  act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await settle(30);
};
const stations = (host: HTMLElement) =>
  [...host.querySelectorAll(`${RULES} li`)].map((li) => li.textContent);

describe('The line of a connection', () => {
  test('it draws the source, a station for each rule that is on in the order an event meets them, and the destination', async () => {
    serveGateway([route({ filter: { queue: 'emails' }, shape: { text: 'x' }, delayMs: 5_000 })]);
    const view = overview();
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('The line of this connection');
    expect(stations(view.host)).toEqual(['FilterOn', 'ShapeOn', 'DelayOn']);
    expect(view.host.querySelectorAll('[data-wire]')).toHaveLength(1);
    const always = [...view.host.querySelectorAll('li')].find(
      (li) => li.textContent === 'Always on, after these:'
    );
    expect(always?.parentElement?.children).toHaveLength(1 + Object.keys(FIXED_LABELS).length);
    for (const label of Object.values(FIXED_LABELS)) expect(text).toContain(label);
    view.unmount();
  });

  test('with no rule set it says so, and still lists the rules that are always on', async () => {
    serveGateway([route()]);
    const view = overview();
    await settle(20);
    expect(view.host.querySelector(RULES)).toBeNull();
    expect(view.host.textContent).toContain('No rules set. Always on:');
    view.unmount();
  });

  test('a comet runs only when a poll finds more successful events, never on the first read or a fall', async () => {
    serveGateway([route({ successCount: 3 })]);
    const view = overview();
    await settle(20);
    expect(view.host.querySelector('.motion-comet')).toBeNull();
    await poll();
    expect(view.host.querySelector('.motion-comet')).toBeNull();
    serveGateway([route({ successCount: 2 })]);
    await poll();
    expect(view.host.querySelector('.motion-comet')).toBeNull();
    serveGateway([route({ successCount: 5 })]);
    await poll();
    expect(view.host.querySelectorAll('.motion-comet')).toHaveLength(1);
    view.unmount();
  });

  test('"Sent so far" washes a figure only when a poll moves it', async () => {
    serveGateway([route({ successCount: 4, failureCount: 1 })]);
    const view = overview();
    await settle(20);
    expect(view.host.querySelector('.motion-flash')).toBeNull();
    await poll();
    expect(view.host.querySelector('.motion-flash')).toBeNull();
    serveGateway([route({ successCount: 4, failureCount: 2 })]);
    await poll();
    const flashed = [...view.host.querySelectorAll('.motion-flash')];
    expect(flashed.map((figure) => figure.textContent)).toEqual(['2']);
    view.unmount();
  });

  test('the tab body arrives with motion, and no underline is placed before the page has a layout', async () => {
    serveGateway([route()]);
    const view = overview();
    await settle(20);
    expect(view.host.querySelector('.motion-arrive')?.textContent).toContain('Details');
    expect(view.host.querySelector('.tab-ind')).toBeNull();
    expect(
      view.host.querySelector('nav[aria-label="This connection"] [aria-current="page"]')
        ?.textContent
    ).toBe('Overview');
    view.unmount();
  });

  test('with reduced motion the finished line is in the page at once', async () => {
    const real = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      serveGateway([route({ delayMs: 5_000 })]);
      const view = overview();
      await settle(20);
      expect(stations(view.host)).toEqual(['DelayOn']);
      expect(view.host.querySelector('[data-wire="solid"]')).not.toBeNull();
      view.unmount();
    } finally {
      window.matchMedia = real;
    }
  });
});

describe('The chain on its own', () => {
  const end = { kind: 'http' as const, icon: 'M0 0', name: 'receiver.test' };
  const view = (props: Partial<Parameters<typeof ConnectionChain>[0]> = {}) =>
    render(
      createElement(ConnectionChain, {
        source: { ...end, kind: 'source', name: 'Source: src_1' },
        destination: end,
        stations: [],
        state: 'active',
        ...props,
      })
    );

  test('it holds no control', () => {
    const shown = view({ stations: [{ name: 'Filter', word: 'On' }] });
    expect(
      shown.host.querySelectorAll('a, button, input, select, textarea, [tabindex]')
    ).toHaveLength(0);
    shown.unmount();
  });

  test('an end not chosen yet is a dashed outline and its name says what is missing', () => {
    const shown = view({
      destination: { ...end, name: 'Choose a destination', missing: true },
      state: 'off',
    });
    const names = [...shown.host.querySelectorAll('[class~="border-dashed"]')].map(
      (node) => node.textContent
    );
    expect(names).toEqual(['Choose a destination']);
    shown.unmount();
  });
});
