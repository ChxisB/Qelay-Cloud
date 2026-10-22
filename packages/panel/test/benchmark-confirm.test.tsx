import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, Fragment } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { Benchmark } from '../src/pages/control/Benchmark';
import { LIMITS } from '../src/pages/control/benchmark/engine';
import { changeControl, click, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// Run and Clean ask in the page's own dialog (the real ConfirmDialog is mounted here). Escape, Cancel and a second
// click leave the benchmark exactly as it was, and a value over its limit blocks Run instead of being clamped.

const SHOWN = '[role="alertdialog"]';
const realFetch = globalThis.fetch;
const empty = {
  waiting: 0,
  prioritized: 0,
  delayed: 0,
  active: 0,
  paused: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
};

let writes: string[];
let views: Array<{ unmount: () => void }>;

beforeEach(() => {
  ensureDom();
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
  writes = [];
  views = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url.pathname}`);
    if (url.pathname.endsWith('/counts')) return Response.json({ ok: true, counts: empty });
    return Response.json({ ok: true, count: 0 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const view of views) view.unmount();
  globalThis.fetch = realFetch;
  useConfirmStore.setState({ current: null, queue: [] });
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

async function mount() {
  const view = renderUi(
    createElement(
      Fragment,
      null,
      createElement(MemoryRouter, null, createElement(Benchmark)),
      createElement(ConfirmDialog)
    )
  );
  views.push(view);
  await settle(40);
  return view.host;
}

const dialog = (host: HTMLElement) => host.querySelector<HTMLElement>(SHOWN);
const named = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const press = (scope: ParentNode, text: string) => {
  const found = named(scope, text);
  if (!found) throw new Error(`Missing button ${text}`);
  click(found);
};
const escape = () =>
  act(() =>
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );

describe('Run benchmark', () => {
  test('asks with the target and the warning, and Escape starts nothing', async () => {
    const host = await mount();
    press(host, 'Run benchmark');
    await settle(10);
    expect(dialog(host)?.textContent).toContain('Run the benchmark?');
    expect(dialog(host)?.textContent).toContain('on http://srv?');

    escape();
    await settle(260);
    expect(dialog(host)).toBeNull();
    expect(named(host, 'Run benchmark')).toBeDefined();
    expect(named(host, 'Stop')).toBeUndefined();
    expect(host.textContent).toContain('Ready');
    expect(writes).toEqual([]);
  });

  test('a second click while the question is open asks once; a yes starts the run', async () => {
    const host = await mount();
    const run = named(host, 'Run benchmark')!;
    click(run);
    click(run);
    await settle(10);
    expect(host.querySelectorAll(SHOWN)).toHaveLength(1);

    press(dialog(host)!, 'Run benchmark');
    await settle(80);
    expect(writes.length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain('Ready');
    // The run only ever pushes to its own dedicated queue.
    for (const write of writes) expect(write).toContain('/queues/');
    if (named(host, 'Stop')) press(host, 'Stop');
    await settle(200);
  });
});

describe('Clean queue', () => {
  test('asks as a danger question and Cancel cleans nothing', async () => {
    const host = await mount();
    press(host, 'Clean queue');
    await settle(10);
    expect(dialog(host)?.textContent).toContain('Clean the benchmark queue?');
    expect(dialog(host)?.textContent).toContain('queue-wide');
    expect(named(dialog(host)!, 'Clean queue')?.className).not.toBe(
      named(dialog(host)!, 'Cancel')?.className
    );

    press(dialog(host)!, 'Cancel');
    await settle(260);
    expect(writes).toEqual([]);
    expect(named(host, 'Clean queue')?.hasAttribute('disabled')).toBe(false);
  });

  test('a yes cleans the dedicated queue only, and the result is a glyph plus a sentence', async () => {
    const host = await mount();
    press(host, 'Clean queue');
    await settle(10);
    press(dialog(host)!, 'Clean queue');
    await settle(120);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write).toMatch(/^POST \/queues\/[^/]+\/clean$/);
    const result = host.querySelector('[role="status"].motion-arrive');
    expect(result?.textContent).toContain('Cleaned — 0 jobs remain');
    expect(result?.querySelector('svg')).not.toBeNull();
  });
});

describe('A value over its limit', () => {
  test('turns its field red and dims Run, and Run asks nothing', async () => {
    const host = await mount();
    const total = host.querySelector<HTMLInputElement>('input[name="benchmark-total"]')!;
    expect(total.getAttribute('aria-invalid')).toBeNull();

    changeControl(total, String(LIMITS.total + 1));
    expect(total.getAttribute('aria-invalid')).toBe('true');
    const run = named(host, 'Run benchmark')!;
    expect(run.getAttribute('aria-disabled')).toBe('true');
    click(run);
    await settle(10);
    expect(dialog(host)).toBeNull();

    changeControl(total, String(LIMITS.total));
    expect(total.getAttribute('aria-invalid')).toBeNull();
    expect(named(host, 'Run benchmark')?.getAttribute('aria-disabled')).toBeNull();
  });
});
