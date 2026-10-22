import { Metrics } from '../src/pages/control/gateway/Metrics';
import { at, route, serveGateway, stats } from './gateway.helpers';
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

const METRICS = '/events-gateway/metrics';
const strip = (host: HTMLElement) => {
  let el = [...host.querySelectorAll('h3')].find(
    (h) => h.textContent === 'Where events went'
  )?.parentElement;
  while (el && !el.querySelector('ul')) el = el.parentElement;
  return el ?? undefined;
};
const rows = (host: HTMLElement) =>
  [...strip(host)!.querySelectorAll('li')].map((li) => li.textContent ?? '');
const poll = async () => {
  act(() => document.dispatchEvent(new window.Event('visibilitychange')));
  await settle(30);
};

describe('Gateway metrics: where events went', () => {
  test('says the total and, for each end state, its count and share in words', async () => {
    serveGateway([route()], [], stats({ delivered: 8, failed: 2, pending: 1 }));
    const view = at(METRICS, createElement(Metrics));
    await settle(30);
    expect(strip(view.host)?.textContent).toContain('Events matched');
    expect(strip(view.host)?.textContent).toContain('11');
    const [ok, bad, wait] = rows(view.host);
    expect(ok).toContain('Successful');
    expect(ok).toContain('8 · 72.7%');
    expect(bad).toContain('Failed');
    expect(bad).toContain('2 · 18.2%');
    expect(wait).toContain('Pending');
    expect(wait).toContain('1 · 9.1%');
    view.unmount();
  });

  test('a range with no events keeps its empty message and draws no strip', async () => {
    serveGateway([route()], [], stats({ delivered: 0, failed: 0, pending: 0, failureRatio: null }));
    const view = at(METRICS, createElement(Metrics));
    await settle(30);
    expect(view.host.textContent).toContain('No events in this window');
    expect(strip(view.host)).toBeUndefined();
    view.unmount();
  });

  test('a poll that finds a new event washes the changed figures once, and a poll that finds nothing washes none', async () => {
    const live = stats({ delivered: 8, failed: 2, pending: 1 });
    serveGateway([route()], [], live);
    const view = at(METRICS, createElement(Metrics));
    await settle(30);
    const washed = () => strip(view.host)!.querySelectorAll('.motion-flash').length;
    expect(washed()).toBe(0);
    await poll();
    expect(washed()).toBe(0);
    live.delivered = 9;
    await poll();
    // The total and the successful count moved; the failed and pending counts did not.
    expect(washed()).toBe(2);
    view.unmount();
  });
});
