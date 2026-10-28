import { Issues } from '../src/pages/control/gateway/Issues';
import { asViewer, at, issue, route, serveGateway } from './gateway.helpers';
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

const ISSUES = '/events-gateway/issues';
const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('ul > li')];
const wire = (card: HTMLElement) => card.querySelector('[data-wire]')?.getAttribute('data-wire');
const poll = async () => {
  act(() => document.dispatchEvent(new window.Event('visibilitychange')));
  await settle(30);
};

describe('Issues screen: the line an issue is about', () => {
  test('says in words how the connection stands: still trying, stopped itself, recovered', async () => {
    serveGateway([route()], [], undefined, undefined, [
      issue({ id: '1' }),
      issue({ id: '2', pausedBy: 'failures' }),
      issue({ id: '3', status: 'resolved', consecutiveFailures: 0 }),
    ]);
    const open = at(ISSUES, createElement(Issues));
    await settle(20);
    const [trying, stopped] = cards(open.host);
    expect(trying.textContent).toContain('Still trying');
    expect(wire(trying)).toBe('solid');
    expect(stopped.textContent).toContain('Stopped itself');
    expect(wire(stopped)).toBe('dashed');
    open.unmount();
    const resolved = at(`${ISSUES}?status=resolved`, createElement(Issues));
    await settle(20);
    const [recovered] = cards(resolved.host);
    expect(recovered.textContent).toContain('Recovered');
    expect(wire(recovered)).toBe('solid');
    resolved.unmount();
  });

  test('has the source and the destination at its two ends, and a viewer still sees no action', async () => {
    asViewer();
    serveGateway([route()], [], undefined, undefined, [issue()]);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    const [card] = cards(view.host);
    expect(card.textContent).toContain('Still trying');
    expect(card.textContent).toContain('Source: src_1');
    expect(card.textContent).toContain('receiver.test/hook');
    expect([...card.querySelectorAll('button')]).toHaveLength(0);
    view.unmount();
  });

  test('cards rise in a stagger on the first load, and a poll adds one that rises while the rest stay put', async () => {
    const list = [issue({ id: '1' }), issue({ id: '2' })];
    serveGateway([route()], [], undefined, undefined, list);
    const view = at(ISSUES, createElement(Issues));
    await settle(20);
    const first = cards(view.host);
    expect(first.map((card) => card.classList.contains('motion-arrive'))).toEqual([true, true]);
    expect(first.map((card) => card.style.getPropertyValue('--i'))).toEqual(['0', '1']);
    list.push(issue({ id: '3', consecutiveFailures: 4 }));
    await poll();
    const after = cards(view.host);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2).every((card, i) => card === first[i])).toBe(true);
    expect(after[2].classList.contains('motion-arrive')).toBe(true);
    expect(after[2].style.getPropertyValue('--i')).toBe('0');
    view.unmount();
  });
});
