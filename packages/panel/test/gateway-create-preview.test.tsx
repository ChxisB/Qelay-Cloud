import { field, page } from './gateway-create.helpers';
import { field as byLabel, serve, two } from './gateway-destinations.helpers';
import { type } from './gateway.helpers';
import {
  act,
  buttonByText,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const FOCUSABLE = 'a, button, input, select, textarea, [tabindex]';
const aside = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('aside[aria-label="What it will do"]')!;
const dashed = (host: HTMLElement) =>
  [...aside(host).querySelectorAll('[class~="border-dashed"]')].map((node) => node.textContent);
const stations = (host: HTMLElement) =>
  [...aside(host).querySelectorAll('ol[aria-label] li')].map((li) => li.textContent);
const choose = (host: HTMLElement, id: string) => {
  const select = host.querySelector<HTMLSelectElement>('select[name="route-destination"]')!;
  act(() => {
    select.value = id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};

describe('New connection: what it will do', () => {
  test('it starts with the end that is missing as a dashed placeholder that says what to enter', async () => {
    serve([]);
    const view = page();
    await settle(20);
    expect(aside(view.host).textContent).toContain('Drawn from the form. Not saved.');
    expect(aside(view.host).textContent).toContain('Qelay jobs: all queues');
    expect(dashed(view.host)).toEqual(['Enter the address to send to']);
    expect(aside(view.host).querySelector('[data-wire="dotted"]')).not.toBeNull();
    expect(aside(view.host).textContent).toContain('No rules set. Always on:');
    view.unmount();
  });

  test('it follows the queue, the address and the signing secret as they are typed', async () => {
    serve([]);
    const view = page();
    await settle(20);
    type(field(view.host, 'webhook-queue'), 'orders');
    type(field(view.host, 'webhook-url'), 'https://receiver.test/hook');
    const text = aside(view.host).textContent ?? '';
    expect(text).toContain('Qelay jobs: orders');
    expect(text).toContain('receiver.test');
    expect(text).toContain('unsigned');
    expect(dashed(view.host)).toEqual([]);
    expect(aside(view.host).querySelector('[data-wire="solid"]')).not.toBeNull();
    type(field(view.host, 'webhook-secret'), 'a-secret-of-sixteen-chars');
    expect(aside(view.host).textContent).toContain('signed');
    expect(aside(view.host).textContent).not.toContain('unsigned');
    view.unmount();
  });

  test('a rule joins the line once its box holds text, in the order an event meets them', async () => {
    serve([]);
    const view = page();
    await settle(20);
    type(byLabel(view.host, 'Delay'), '5');
    type(byLabel(view.host, 'Filter'), '{ "queue": "a" }');
    expect(stations(view.host)).toEqual(['FilterOn', 'DelayOn']);
    type(byLabel(view.host, 'Delay'), '  ');
    expect(stations(view.host)).toEqual(['FilterOn']);
    view.unmount();
  });

  test('a queue destination needs both queues, and each missing one is a placeholder with words', async () => {
    serve([]);
    const view = page();
    await settle(20);
    act(() => buttonByText(view.host, 'Another queue').click());
    expect(dashed(view.host).sort()).toEqual([
      'Choose the queue to add jobs to',
      'Choose the source queue',
    ]);
    type(field(view.host, 'webhook-queue'), 'orders');
    type(field(view.host, 'route-target'), 'refunds');
    expect(aside(view.host).textContent).toContain('Queue: refunds');
    expect(aside(view.host).textContent).toContain('Qelay jobs: orders');
    expect(dashed(view.host)).toEqual([]);
    view.unmount();
  });

  test('a saved destination is drawn once chosen, and asks for the choice before', async () => {
    serve(two());
    const view = page();
    await settle(20);
    act(() => buttonByText(view.host, 'Saved destination').click());
    expect(dashed(view.host)).toEqual(['Choose a destination']);
    choose(view.host, 'dest-1');
    expect(dashed(view.host)).toEqual([]);
    expect(aside(view.host).textContent).toContain('billing.test');
    choose(view.host, 'dest-2');
    expect(aside(view.host).textContent).toContain('Queue: refunds');
    expect(dashed(view.host)).toEqual(['Choose the source queue']);
    view.unmount();
  });

  test('typing makes no call, keeps the field and its focus, and the aside adds nothing to the tab order', async () => {
    const calls = serve([]);
    const view = page();
    await settle(20);
    const before = calls.seen.length;
    const url = field(view.host, 'webhook-url');
    url.focus();
    for (const typed of ['h', 'ht', 'https://receiver.test/a-very-long-address-to-type']) {
      type(url, typed);
    }
    expect(calls.seen.length).toBe(before);
    expect(field(view.host, 'webhook-url')).toBe(url);
    expect(document.activeElement).toBe(url);
    expect(url.value).toBe('https://receiver.test/a-very-long-address-to-type');
    expect(aside(view.host).querySelectorAll(FOCUSABLE)).toHaveLength(0);
    view.unmount();
  });
});
