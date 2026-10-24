import { Route, Routes } from 'react-router-dom';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import { asViewer, at, route, serveGateway } from './gateway.helpers';
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

const page = () =>
  at(
    '/events-gateway/connections/hook-1',
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/events-gateway/connections/:id',
        element: createElement(ConnectionPage, { tab: 'overview' }),
      })
    )
  );
const orphan = () => route({ source: null, enabled: false });

describe('A connection that lost its source', () => {
  test('an operator chooses a source for it, and only the source is sent', async () => {
    const calls = serveGateway([orphan()]);
    const view = page();
    await settle(20);
    expect(view.host.textContent).toContain('This connection needs a source');
    const choose = view.host.querySelector<HTMLSelectElement>('select[name="webhook-source"]')!;
    expect(buttonByText(view.host, 'Use this source').disabled).toBe(true);
    act(() => {
      choose.value = 'src_1';
      choose.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    act(() => buttonByText(view.host, 'Use this source').click());
    await settle(30);
    expect(calls.seen).toContain('PATCH /webhooks/hook-1');
    expect(calls.bodies).toEqual([{ source: 'src_1' }]);
    view.unmount();
  });

  test('a viewer is told, and has nothing to choose', async () => {
    asViewer();
    serveGateway([orphan()]);
    const view = page();
    await settle(20);
    expect(view.host.textContent).toContain('An operator can choose one.');
    expect(view.host.querySelector('select[name="webhook-source"]')).toBeNull();
    view.unmount();
  });

  test('a connection with a source is not asked for one', async () => {
    serveGateway([route()]);
    const view = page();
    await settle(20);
    expect(view.host.textContent).not.toContain('needs a source');
    view.unmount();
  });
});
