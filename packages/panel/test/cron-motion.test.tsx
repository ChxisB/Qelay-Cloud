import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { CronManager } from '../src/pages/control/CronManager';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

// The Cron page: rows that arrive once, a run count that sends a comet down its queue line when it rises, a removed row
// that leaves instead of vanishing, both questions asked in the page, and the "What this will do" wire in the form.
// happy-dom plays no animation, so these check what is drawn, what is asked and what is sent.

const realFetch = globalThis.fetch;
const mounted: Array<() => void> = [];
let stopAnswering = () => {};

const cron = (name: string, executions = 0) => ({
  name,
  queue: 'orders',
  schedule: '0 8 * * *',
  nextRun: 1_900_000_000_000,
  executions,
});
let crons: ReturnType<typeof cron>[] = [];
let deletes: string[] = [];
let creates: string[] = [];

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'DELETE' && url.includes('/crons/')) {
      const name = decodeURIComponent(url.split('/crons/')[1] ?? '');
      deletes.push(name);
      crons = crons.filter((row) => row.name !== name);
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (method === 'POST' && url.endsWith('/crons')) {
      const body = JSON.parse(String(init?.body)) as { name: string; queue: string };
      creates.push(body.name);
      return Promise.resolve(Response.json({ ok: true, cron: body }));
    }
    if (url.endsWith('/crons')) return Promise.resolve(Response.json({ ok: true, crons }));
    return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
  }) as typeof fetch;
}

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, null, element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const click = (el: Element | null | undefined) =>
  act(async () => void el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const propsKey = Object.getOwnPropertyNames(input).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((input as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: input, currentTarget: input });
  });
}

const field = (host: HTMLElement, name: string) =>
  host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const rowOf = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(name));
const openForm = (host: HTMLElement) =>
  click([...host.querySelectorAll('button')].find((b) => b.textContent === 'New schedule'));

beforeEach(() => {
  ensureDom();
  crons = [cron('nightly'), cron('hourly')];
  deletes = [];
  creates = [];
  serve();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 20,
  });
});

afterEach(() => {
  stopAnswering();
  stopAnswering = () => {};
  for (const unmount of mounted.splice(0)) unmount();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
});

describe('Cron table', () => {
  test('the rows of the first load arrive in order; a row a poll adds later does not', async () => {
    const host = mount(createElement(CronManager));
    await settle(80);
    const arrivals = () =>
      [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map((tr) =>
        tr.style.getPropertyValue('--i')
      );
    expect(arrivals()).toEqual(['0', '1']);
    crons = [...crons, cron('weekly')];
    await settle(80);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(arrivals()).toEqual(['0', '1']);
  });

  test('a poll that changes nothing washes no count; a rising count sends one comet, a falling one none', async () => {
    crons = [cron('nightly', 5)];
    const host = mount(createElement(CronManager));
    await settle(80);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);
    expect(host.querySelectorAll('.motion-comet')).toHaveLength(0);

    crons = [cron('nightly', 6)];
    await settle(80);
    expect(rowOf(host, 'nightly')?.querySelectorAll('.motion-comet')).toHaveLength(1);

    const comets = host.querySelectorAll('.motion-comet').length;
    crons = [cron('nightly', 2)];
    await settle(80);
    expect(rowOf(host, 'nightly')?.textContent).toContain('2');
    expect(host.querySelectorAll('.motion-comet').length).toBeLessThanOrEqual(comets);
  });

  test('the next run stays text, in its own cell', async () => {
    const host = mount(createElement(CronManager));
    await settle(80);
    const cells = [...(rowOf(host, 'nightly')?.querySelectorAll('td') ?? [])];
    expect(cells.some((td) => /\d{4}/.test(td.textContent ?? '') && td.children.length === 0)).toBe(
      true
    );
  });
});

describe('Cron questions', () => {
  test('Delete asks in the page; cancel sends nothing, yes sends the DELETE and the row leaves', async () => {
    const asked = answerConfirms(false);
    stopAnswering = asked.stop;
    const host = mount(createElement(CronManager));
    await settle(80);
    await click(host.querySelector('[aria-label="Delete cron nightly"]'));
    await settle(20);
    expect(asked.questions).toEqual([
      { question: 'Delete cron "nightly"?', confirmLabel: 'Delete cron', danger: true },
    ]);
    expect(deletes).toEqual([]);
    expect(rowOf(host, 'nightly')).toBeDefined();

    asked.stop();
    stopAnswering = answerConfirms(true).stop;
    await click(host.querySelector('[aria-label="Delete cron nightly"]'));
    await settle(60);
    expect(deletes).toEqual(['nightly']);
    const leaving = rowOf(host, 'nightly');
    expect(leaving?.classList.contains('motion-leave')).toBe(true);
    expect(leaving?.hasAttribute('inert')).toBe(true);
    await settle(260);
    expect(rowOf(host, 'nightly')).toBeUndefined();
    expect(rowOf(host, 'hourly')).toBeDefined();
  });

  test('Create asks in the page; cancel sends no POST, yes sends it', async () => {
    const asked = answerConfirms(false);
    stopAnswering = asked.stop;
    const host = mount(createElement(CronManager));
    await settle(80);
    await openForm(host);
    setInput(field(host, 'cron-name'), 'daily');
    setInput(field(host, 'cron-queue'), 'orders');
    setInput(field(host, 'cron-expression'), '0 9 * * *');
    const submit = () =>
      act(async () => {
        host
          .querySelector('form')!
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(40);
      });
    await submit();
    expect(asked.questions).toEqual([
      {
        question: 'Create the schedule "daily"?',
        confirmLabel: 'Create schedule',
        danger: undefined,
      },
    ]);
    expect(creates).toEqual([]);

    asked.stop();
    stopAnswering = answerConfirms(true).stop;
    await submit();
    expect(creates).toEqual(['daily']);
  });
});

describe('Cron wire', () => {
  test('"What this will do" shows the schedule, the queue and the sentence; next runs are chips', async () => {
    const host = mount(createElement(CronManager));
    await settle(80);
    await openForm(host);
    const wire = () => host.querySelector('[role="group"][aria-label="What this will do"]');
    expect(wire()?.textContent).toContain('not set yet');
    expect(wire()?.textContent).toContain('choose a queue');
    expect(wire()?.querySelectorAll('.motion-draw, .motion-draw-y')).toHaveLength(0);

    setInput(field(host, 'cron-queue'), 'reports');
    setInput(field(host, 'cron-job-name'), 'send-report');
    setInput(field(host, 'cron-expression'), '0 9 * * *');
    expect(wire()?.textContent).toContain('0 9 * * *');
    expect(wire()?.textContent).toContain('reports');
    expect(wire()?.textContent).toContain(
      'Adds a "send-report" job to the queue each time the schedule fires.'
    );
    expect(wire()?.querySelectorAll('.motion-draw, .motion-draw-y')).toHaveLength(1);
    expect(host.querySelectorAll('span.rounded-full.font-mono')).toHaveLength(3);
  });

  test('an expression that does not parse draws no line, and the note still says why', async () => {
    const host = mount(createElement(CronManager));
    await settle(80);
    await openForm(host);
    setInput(field(host, 'cron-queue'), 'reports');
    setInput(field(host, 'cron-expression'), 'not a cron');
    const wire = host.querySelector('[role="group"][aria-label="What this will do"]');
    expect(wire?.querySelectorAll('.motion-draw, .motion-draw-y')).toHaveLength(0);
    expect(host.textContent).toContain('That cron expression is not supported');
    expect(host.querySelectorAll('span.rounded-full.font-mono')).toHaveLength(0);
  });
});
