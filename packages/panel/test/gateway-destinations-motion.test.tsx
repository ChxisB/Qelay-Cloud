import { field, screen, serve, two } from './gateway-destinations.helpers';
import { destination } from './gateway.helpers';
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

const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('ul > li')];
const lines = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-lines]');
const poll = async () => {
  act(() => document.dispatchEvent(new window.Event('visibilitychange')));
  await settle(30);
};

describe('Gateway destinations: the lines into an address', () => {
  test('one line per connection that uses it, with the rest counted and the words kept', async () => {
    serve([
      destination(),
      destination({ id: 'dest-2', name: 'Audit', connections: 6 }),
      destination({ id: 'dest-3', name: 'Spare', connections: 0 }),
    ]);
    const view = screen();
    await settle(20);
    const [two, six, none] = cards(view.host);
    expect(lines(two)?.querySelectorAll('[data-wire]')).toHaveLength(2);
    expect(lines(six)?.querySelectorAll('[data-wire]')).toHaveLength(4);
    expect(lines(six)?.textContent).toContain('+2 more');
    expect(lines(six)?.getAttribute('aria-hidden')).toBe('true');
    expect(six.textContent).toContain('6 connections are made from it.');
    expect(lines(none)).toBeNull();
    expect(none.textContent).toContain('No connection is made from it yet.');
    view.unmount();
  });

  test('they turn dashed while the address is being changed, and go back when it is not', async () => {
    serve(two());
    const view = screen();
    await settle(20);
    const [card] = cards(view.host);
    const wires = () =>
      [...lines(card)!.querySelectorAll('[data-wire]')].map((w) => w.getAttribute('data-wire'));
    expect(wires()).toEqual(['solid', 'solid']);
    act(() => buttonByText(card, 'Edit').click());
    expect(wires()).toEqual(['solid', 'solid']);
    setInput(field(view.host, 'URL'), 'https://new.test/hook');
    expect(wires()).toEqual(['dashed', 'dashed']);
    setInput(field(view.host, 'URL'), 'https://billing.test/hook');
    expect(wires()).toEqual(['solid', 'solid']);
    setInput(field(view.host, 'URL'), 'https://new.test/hook');
    act(() => buttonByText(card, 'Cancel').click());
    expect(wires()).toEqual(['solid', 'solid']);
    view.unmount();
  });

  test('they flash once when the saved address changes, and not before', async () => {
    serve(two());
    const view = screen();
    await settle(20);
    const [card] = cards(view.host);
    expect(lines(card)?.classList.contains('motion-flash')).toBe(false);
    await poll();
    expect(lines(cards(view.host)[0])?.classList.contains('motion-flash')).toBe(false);
    act(() => buttonByText(card, 'Edit').click());
    setInput(field(view.host, 'URL'), 'https://new.test/hook');
    act(() => buttonByText(card, 'Save changes').click());
    await settle(30);
    expect(lines(cards(view.host)[0])?.classList.contains('motion-flash')).toBe(true);
    view.unmount();
  });
});

describe('Gateway destinations: things arrive', () => {
  test('the first load rises in a stagger, and a destination a poll adds rises while the rest stay put', async () => {
    const rows = two();
    serve(rows);
    const view = screen();
    await settle(20);
    const first = cards(view.host);
    expect(first.map((card) => card.classList.contains('motion-arrive'))).toEqual([true, true]);
    expect(first.map((card) => card.style.getPropertyValue('--i'))).toEqual(['0', '1']);
    await poll();
    expect(cards(view.host).every((card, i) => card === first[i])).toBe(true);
    rows.push(destination({ id: 'dest-3', name: 'Audit', connections: 0 }));
    await poll();
    const after = cards(view.host);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2).every((card, i) => card === first[i])).toBe(true);
    expect(after[2].classList.contains('motion-arrive')).toBe(true);
    expect(after[2].style.getPropertyValue('--i')).toBe('0');
    view.unmount();
  });

  test('the edit form opens with the card, leaves in 180 ms and cannot be used while it does', async () => {
    serve(two());
    const view = screen();
    await settle(20);
    const [card] = cards(view.host);
    act(() => buttonByText(card, 'Edit').click());
    const panel = card.querySelector('form')!.parentElement!;
    expect(panel.classList.contains('motion-arrive')).toBe(true);
    act(() => buttonByText(card, 'Cancel').click());
    expect(panel.classList.contains('motion-leave')).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    await settle(260);
    expect(card.querySelector('form')).toBeNull();
    view.unmount();
  });

  test('the new-destination form does the same', async () => {
    serve([]);
    const view = screen();
    await settle(20);
    act(() => buttonByText(view.host, 'Add destination').click());
    const panel = view.host.querySelector('form')!.closest('div.mb-4')!;
    expect(panel.classList.contains('motion-arrive')).toBe(true);
    act(() => buttonByText(view.host, 'Cancel').click());
    expect(panel.classList.contains('motion-leave')).toBe(true);
    await settle(260);
    expect(view.host.querySelector('form')).toBeNull();
    expect(view.host.textContent).toContain('No saved destinations');
    view.unmount();
  });

  test('under reduced motion the form is gone the moment it closes', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      serve(two());
      const view = screen();
      await settle(20);
      const [card] = cards(view.host);
      act(() => buttonByText(card, 'Edit').click());
      expect(card.querySelector('form')).not.toBeNull();
      act(() => buttonByText(card, 'Cancel').click());
      expect(card.querySelector('form')).toBeNull();
      view.unmount();
    } finally {
      window.matchMedia = real;
    }
  });
});
