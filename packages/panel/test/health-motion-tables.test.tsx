import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { TransportQueue } from '../src/lib/ops/types';
import { Diagnostics } from '../src/pages/control/Diagnostics';
import { QueueDoorbellTable } from '../src/pages/control/transport/QueueDoorbellTable';
import { ensureDom, settle } from './domSetup';
import { installOpsHooks, queue, transport } from './ops.helpers';
import { show as showTransport } from './transportPage.helpers';

// Health: Deployment, Transport and Diagnostics. A poll that changes nothing animates nothing; a reading that moves
// washes once; a figure that moves on every poll (an age, an uptime) updates without the wash; warnings rise and leave.
// happy-dom plays no animation, so these check which elements carry the motion classes and whether an element is the
// same one after the update.

installOpsHooks();

const mounted: Array<() => void> = [];
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (next: ReactElement) =>
    act(() => root.render(createElement(MemoryRouter, null, next)));
  show(element);
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, show };
}
beforeEach(ensureDom);
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const placeOf = (el: Element) => (el as HTMLElement).style.getPropertyValue('--i');
const washed = (host: ParentNode) =>
  [...host.querySelectorAll('.motion-flash')].map((el) => el.textContent);

describe('the queue table', () => {
  const table = (queues: TransportQueue[]) =>
    createElement(QueueDoorbellTable, { queues, lateAfterMs: 60_000 });
  const rowsOf = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('tbody tr')];
  const one = (name: string, depth: number, age: number | null = null) =>
    queue(name, { doorbellDepth: depth, oldestUndeliveredAgeMs: age });

  test('the first rows rise in order; one a later poll adds does not', () => {
    const { host, show } = mount(table([one('a', 1), one('b', 2)]));
    expect(rowsOf(host).map((row) => row.classList.contains('motion-arrive'))).toEqual([
      true,
      true,
    ]);
    expect(rowsOf(host).map(placeOf)).toEqual(['0', '1']);

    const before = rowsOf(host);
    show(table([one('a', 1), one('b', 2), one('c', 3)]));
    const after = rowsOf(host);
    expect(after[0]).toBe(before[0]!);
    expect(after[2]!.classList.contains('motion-arrive')).toBe(false);
  });

  test('a reading that moves washes once; an equal poll washes nothing', () => {
    const { host, show } = mount(table([one('a', 1), one('b', 2)]));
    show(table([one('a', 1), one('b', 2)]));
    expect(washed(host)).toEqual([]);

    show(table([one('a', 4), one('b', 2)]));
    expect(washed(host)).toEqual(['4']);
  });

  test('an age counts up without the wash', () => {
    const { host, show } = mount(table([one('a', 1, 5_000)]));
    const cell = () => rowsOf(host)[0]!.textContent;
    const before = cell();
    show(table([one('a', 1, 125_000)]));
    expect(cell()).not.toBe(before);
    expect(washed(host)).toEqual([]);
  });
});

describe('the Transport page', () => {
  test('the delivery line is drawn from the table rows, and absent when there are none', async () => {
    const full = await showTransport(transport([queue('a', { store: { claimable: 2 } })]));
    expect(
      full.page.host.querySelector('[aria-label="How a job gets to a worker"]')
    ).not.toBeNull();
    full.page.unmount();

    const empty = await showTransport(transport([]));
    expect(empty.page.host.querySelector('[aria-label="How a job gets to a worker"]')).toBeNull();
    empty.page.unmount();
  });

  test('no control to redrive or retry anything is drawn, and no request is added', async () => {
    const { page, seen } = await showTransport(
      transport([queue('a', { store: { claimable: 2 } })], { deadLetter: { supported: false } })
    );
    const buttons = [...page.host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.filter((text) => /redrive|replay|requeue|retry/i.test(text))).toEqual([]);
    expect(seen.every((path) => path.startsWith('/transport'))).toBe(true);
    page.unmount();
  });
});

describe('Diagnostics', () => {
  function serve() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/healthz' || path === '/live') return new Response('OK');
      if (path === '/ping') return Response.json({ ok: true, data: { pong: true, time: 1 } });
      if (path === '/gc') {
        return Response.json({
          ok: true,
          before: { rss: 20, heapUsed: 4, heapTotal: 6 },
          after: { rss: 10, heapUsed: 3, heapTotal: 6 },
        });
      }
      if (path === '/ready') {
        return Response.json({ ok: true, ready: true, storage: { diskFull: false } });
      }
      if (path === '/health') {
        return Response.json({
          ok: true,
          status: 'healthy',
          memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
          connections: { tcp: 0, ws: 0, sse: 0 },
        });
      }
      if (path === '/storage') {
        return Response.json({ ok: true, data: { diskFull: false, error: null } });
      }
      return Response.json({ ok: true, metrics: {}, stats: {} });
    }) as typeof fetch;
  }
  const press = (host: ParentNode, text: string) =>
    act(() =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!.click()
    );

  test('the ping result fades in and the compaction message rises, both with the text they had', async () => {
    serve();
    const { host } = mount(createElement(Diagnostics));
    await settle(30);
    expect(host.querySelector('p.motion-arrive')).toBeNull();

    press(host, 'Ping');
    await settle(30);
    const ping = [...host.querySelectorAll('.motion-fade')].find((el) =>
      el.textContent?.startsWith(' · ')
    );
    expect(ping).toBeDefined();
    expect(host.textContent).toContain('Ping · ');

    press(host, 'Compact (GC)');
    await settle(30);
    expect(host.querySelector('p.motion-arrive')?.textContent).toContain('Freed 10 MB');
  });
});
