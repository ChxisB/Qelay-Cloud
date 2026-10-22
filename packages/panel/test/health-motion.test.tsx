import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DeploymentWarning, TransportQueue } from '../src/lib/ops/types';
import { Facts } from '../src/pages/control/deployment/Facts';
import { WarningList } from '../src/pages/control/deployment/WarningList';
import { DeliveryLine } from '../src/pages/control/transport/DeliveryLine';
import { ensureDom, settle } from './domSetup';
import { deployment, installOpsHooks, queue } from './ops.helpers';

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

describe('the warnings', () => {
  const warn = (code: string, severity: 'warning' | 'critical'): DeploymentWarning => ({
    code,
    severity,
    message: `${code} happened.`,
  });
  const rows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-warning]')];
  const list = (warnings: DeploymentWarning[]) => createElement(WarningList, { warnings });

  test('the first load rises in order, critical first, and a critical one is still an alert', () => {
    const { host } = mount(list([warn('a_warning', 'warning'), warn('b_critical', 'critical')]));
    expect(rows(host).map((row) => row.dataset.warning)).toEqual(['b_critical', 'a_warning']);
    expect(rows(host).map((row) => row.classList.contains('motion-arrive'))).toEqual([true, true]);
    expect(rows(host).map(placeOf)).toEqual(['0', '1']);
    expect(rows(host).map((row) => row.getAttribute('role'))).toEqual(['alert', 'status']);
  });

  test('a later warning rises alone; the ones already there keep their element', () => {
    const { host, show } = mount(
      list([warn('b_critical', 'critical'), warn('a_warning', 'warning')])
    );
    const before = rows(host);
    show(
      list([
        warn('b_critical', 'critical'),
        warn('a_warning', 'warning'),
        warn('c_late', 'warning'),
      ])
    );
    const after = rows(host);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]!);
    expect(after[1]).toBe(before[1]!);
    expect(placeOf(after[2]!)).toBe('0');
    expect(after[2]!.classList.contains('motion-arrive')).toBe(true);
  });

  test('a poll that changes nothing keeps every element and replays nothing', () => {
    const same = () => [warn('b_critical', 'critical'), warn('a_warning', 'warning')];
    const { host, show } = mount(list(same()));
    const before = rows(host);
    show(list(same()));
    expect(rows(host)).toEqual(before);
    expect(rows(host).every((row) => !row.classList.contains('motion-leave'))).toBe(true);
  });

  test('a warning that clears leaves first, and only then does the all-clear appear', async () => {
    const { host, show } = mount(list([warn('a_warning', 'warning')]));
    show(list([]));
    const [leaving] = rows(host);
    expect(leaving?.classList.contains('motion-leave')).toBe(true);
    expect(leaving?.hasAttribute('inert')).toBe(true);
    expect(host.textContent).not.toContain('No warnings.');

    await settle(60);
    await settle(260);
    expect(rows(host)).toHaveLength(0);
    expect(host.textContent).toContain('No warnings.');
  });
});

describe('the deployment facts', () => {
  const NOW = 1_800_000_000_000;
  const facts = (patch = {}) => createElement(Facts, { deployment: deployment(patch) });
  const valueOf = (host: ParentNode, label: string) =>
    [...host.querySelectorAll('dt')].find((dt) => dt.textContent === label)
      ?.nextElementSibling as HTMLElement;

  test('an equal poll washes nothing; a moved count washes once', () => {
    const { host, show } = mount(facts());
    expect(washed(host)).toEqual([]);
    show(facts());
    expect(washed(host)).toEqual([]);

    show(facts({ workers: { total: 5, active: 3 } }));
    expect(washed(host)).toEqual(['5']);
  });

  test('a timing that moves on every poll changes without the wash', () => {
    const { host, show } = mount(facts());
    const before = valueOf(host, 'Response time').textContent;
    show(facts({ database: { state: 'ok', latencyMs: 900 } }));
    expect(valueOf(host, 'Response time').textContent).not.toBe(before);
    expect(washed(host)).toEqual([]);
  });

  test('a new last-success time washes the date; the age beside it only counts up', () => {
    const now = spyOn(Date, 'now').mockReturnValue(NOW);
    const { host, show } = mount(facts());
    const before = valueOf(host, 'Last success').textContent;

    now.mockReturnValue(NOW + 30_000);
    show(facts());
    expect(valueOf(host, 'Last success').textContent).not.toBe(before);
    expect(washed(host)).toEqual([]);

    show(
      facts({
        tick: { ...deployment().tick, lastSuccessAt: NOW - 3_600_000 },
      })
    );
    expect(washed(host)).toHaveLength(1);
    expect(valueOf(host, 'Last success').querySelector('.motion-flash')).not.toBeNull();
    now.mockRestore();
  });

  test('a definition list holds only term and value groups; the connections bar sits outside it', () => {
    const { host } = mount(facts());
    expect(host.querySelector('[role="meter"]')).not.toBeNull();
    const strays = [...host.querySelectorAll('dl > *')].filter(
      (child) =>
        child.tagName !== 'DIV' ||
        [...child.children].map((part) => part.tagName).join() !== 'DT,DD'
    );
    expect(strays.map((child) => child.outerHTML.slice(0, 60))).toEqual([]);
  });
});

describe('the delivery line', () => {
  const line = (
    queues: TransportQueue[],
    over: { approximate?: boolean; truncated?: boolean } = {}
  ) =>
    createElement(DeliveryLine, {
      queues,
      lateAfterMs: 60_000,
      approximate: over.approximate ?? false,
      truncated: over.truncated ?? false,
    });
  const said = (host: ParentNode) => host.querySelector('p.sr-only')?.textContent ?? '';
  const comets = (host: ParentNode) => host.querySelectorAll('[class*="motion-comet"]');

  const busy = () => [
    queue('a', {
      doorbellDepth: 3,
      inFlight: 1,
      store: { claimable: 5, notRung: 2, oldestNotRungAgeMs: 5_000 },
    }),
    queue('b', {
      doorbellDepth: 4,
      inFlight: 2,
      deadLetterDepth: 1,
      store: { claimable: 7 },
    }),
  ];

  test('every total is a sum over the rows shown', () => {
    const { host } = mount(line(busy()));
    const text = said(host);
    expect(text).toContain('12 ready to run');
    expect(text).toContain('2 not told yet, oldest ');
    expect(text).toContain('7 in the queue service');
    expect(text).toContain('1 given up on');
    expect(text).toContain('3 picked up');
    expect(text).not.toContain('cut off');
    expect(text).not.toContain('Maintenance is behind');
  });

  test('one unknown figure makes the whole total unknown, and says which queues did not answer', () => {
    const rowsIn = busy();
    rowsIn[1] = queue('b', { doorbellDepth: null, inFlight: 2, store: { claimable: 7 } });
    const { host } = mount(line(rowsIn));
    expect(said(host)).toContain('unknown in the queue service');
    expect(host.textContent).toContain('1 of 2 queues did not answer');
    expect(said(host)).not.toContain('7 in the queue service');
  });

  test('a table that is cut off says these are the queues shown', () => {
    const { host } = mount(line(busy(), { truncated: true }));
    expect(said(host)).toContain('(the table is cut off)');
    expect(host.textContent).toContain('not every queue');
  });

  test('a queue service that does not count picked-up jobs says so instead of showing 0', () => {
    const { host } = mount(line([queue('a', { doorbellDepth: 3, store: { claimable: 5 } })]));
    expect(said(host)).toContain('not reported picked up');
    expect(host.textContent).toContain('This queue service does not count them');
  });

  test('approximate counts are marked, and so is the label', () => {
    const { host } = mount(line(busy(), { approximate: true }));
    expect(said(host)).toContain('≈7 in the queue service');
    expect(said(host)).toContain('≈3 picked up');
    expect(host.textContent).toContain('Picked up (≈)');
  });

  test('a row where maintenance is late says so', () => {
    const { host } = mount(
      line([
        queue('a', {
          doorbellDepth: 0,
          store: { claimable: 3, notRung: 3, oldestNotRungAgeMs: 120_000 },
        }),
      ])
    );
    expect(said(host)).toContain('Maintenance is behind.');
  });

  test('a line pulses when the count at its end really changes, and on nothing else', () => {
    const { host, show } = mount(line(busy()));
    expect(comets(host)).toHaveLength(0);
    show(line(busy()));
    expect(comets(host)).toHaveLength(0);

    const next = busy();
    next[0] = queue('a', {
      doorbellDepth: 9,
      inFlight: 1,
      store: { claimable: 5, notRung: 2, oldestNotRungAgeMs: 5_000 },
    });
    show(line(next));
    expect(comets(host).length).toBeGreaterThan(0);
  });
});
