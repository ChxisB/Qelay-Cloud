import { Route, Routes } from 'react-router-dom';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { at, route, serveGateway } from './gateway.helpers';
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

const settings = () =>
  at(
    '/events-gateway/connections/hook-1/settings',
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/events-gateway/connections/:id/settings',
        element: createElement(ConnectionPage, { tab: 'settings' }),
      })
    )
  );
const hasButton = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === text);

describe('Connection settings: pause and disable', () => {
  test('Pause holds events and Disable ignores them, and each says so', async () => {
    const calls = serveGateway([route()]);
    const view = settings();
    await settle(20);
    const text = view.host.textContent ?? '';
    expect(text).toContain('Events keep being collected while it is paused');
    expect(text).toContain('Resume sends them');
    expect(text).toContain('are ignored');
    act(() => buttonByText(view.host, 'Pause').click());
    await settle(20);
    expect(calls.bodies).toContainEqual({ enabled: false, mode: 'hold' });
    view.unmount();

    const ignored = serveGateway([route()]);
    const again = settings();
    await settle(20);
    act(() => buttonByText(again.host, 'Disable').click());
    await settle(20);
    expect(ignored.bodies).toContainEqual({ enabled: false, mode: 'ignore' });
    again.unmount();
  });

  test('a held connection says it is collecting and offers Resume; a disabled one offers Enable', async () => {
    const held = serveGateway([
      route({ enabled: false, pausedBy: 'operator', disabledReason: 'paused by an operator' }),
    ]);
    const view = settings();
    await settle(20);
    expect(view.host.textContent).toContain('Events are being collected');
    expect(hasButton(view.host, 'Pause')).toBe(false);
    act(() => buttonByText(view.host, 'Resume').click());
    await settle(20);
    expect(held.bodies).toContainEqual({ enabled: true });
    view.unmount();

    const off = serveGateway([route({ enabled: false })]);
    const again = settings();
    await settle(20);
    expect(again.host.textContent).toContain('events that happen now are ignored');
    act(() => buttonByText(again.host, 'Enable').click());
    await settle(20);
    expect(off.bodies).toContainEqual({ enabled: true });
    again.unmount();
  });

  test('a connection paused after failures says why and offers Resume', async () => {
    serveGateway([route({ enabled: false, disabledReason: '20 failed deliveries in a row' })]);
    const view = settings();
    await settle(20);
    expect(view.host.textContent).toContain('20 failed deliveries in a row');
    expect(hasButton(view.host, 'Resume')).toBe(true);
    view.unmount();
  });
});
