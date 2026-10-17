import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import type { DeploymentView } from '../src/lib/ops/types';
import { StatusStrip } from '../src/pages/control/overview/StatusStrip';
import { settle } from './domSetup';
import { deployment, installOpsHooks, mountRouted, serveOps } from './ops.helpers';

installOpsHooks();

async function strip(body: DeploymentView | { status: number; body: unknown }) {
  serveOps({ '/deployment': body });
  const page = mountRouted(createElement(StatusStrip), '/');
  await settle(80);
  const el = page.host.querySelector('[data-testid="status-strip"]') as HTMLElement;
  return { page, el };
}

const tick = (state: DeploymentView['tick']['state'], ageMs: number | null) => ({
  tick: { ...deployment().tick, state, ageMs, lastSuccessAt: ageMs === null ? null : 1 },
});

describe('the Dashboard status strip', () => {
  test('a tick that ran a moment ago is green and says how long ago', async () => {
    const { page, el } = await strip(deployment(tick('ok', 4_000)));
    expect(el.getAttribute('data-tone')).toBe('green');
    expect(el.textContent).toContain('Healthy');
    expect(el.textContent).toContain('Tick ran 4s ago');
    page.unmount();
  });

  test('a late tick is amber and a stalled one is red, each in words as well as colour', async () => {
    const late = await strip(deployment(tick('late', 90_000)));
    expect(late.el.getAttribute('data-tone')).toBe('amber');
    expect(late.el.textContent).toContain('Falling behind');
    late.page.unmount();
    const stale = await strip(deployment(tick('stale', 400_000)));
    expect(stale.el.getAttribute('data-tone')).toBe('red');
    expect(stale.el.textContent).toContain('Needs attention');
    stale.page.unmount();
  });

  test('a tick that never ran is red, not "unknown"', async () => {
    const { page, el } = await strip(deployment(tick('never', null)));
    expect(el.getAttribute('data-tone')).toBe('red');
    expect(el.textContent).toContain('Tick has not run yet');
    page.unmount();
  });

  test('a tick nobody reports is unknown, not healthy', async () => {
    const { page, el } = await strip(deployment(tick('unknown', null)));
    expect(el.getAttribute('data-tone')).toBe('zinc');
    expect(el.textContent).toContain('Tick status unknown');
    expect(el.textContent).not.toContain('Healthy');
    page.unmount();
  });

  test('shows the doorbells without a bell, and "unknown" when they were not read', async () => {
    const some = await strip(
      deployment({
        doorbells: { notRung: 12, oldestNotRungAgeMs: 4_000, queuesScanned: 2, partial: false },
      })
    );
    expect(some.el.textContent).toContain('12 jobs without a doorbell');
    some.page.unmount();
    const none = await strip(
      deployment({
        doorbells: { notRung: null, oldestNotRungAgeMs: null, queuesScanned: null, partial: false },
      })
    );
    expect(none.el.textContent).toContain('Doorbells unknown');
    expect(none.el.textContent).not.toContain('0 jobs');
    none.page.unmount();
  });

  test('says "or more" when only some queues were scanned', async () => {
    const { page, el } = await strip(
      deployment({
        doorbells: { notRung: 30, oldestNotRungAgeMs: 4_000, queuesScanned: 50, partial: true },
      })
    );
    expect(el.textContent).toContain('30+ jobs');
    page.unmount();
  });

  test('overdue doorbells colour it even while the tick looks fine', async () => {
    const { page, el } = await strip(
      deployment({
        warnings: [{ code: 'doorbells_overdue', severity: 'critical', message: 'overdue' }],
      })
    );
    expect(el.getAttribute('data-tone')).toBe('red');
    page.unmount();
  });

  test('links to the Deployment page', async () => {
    const { page, el } = await strip(deployment());
    expect(el.getAttribute('href')).toBe('/deployment');
    page.unmount();
  });

  test('an unreachable server is unknown, never green', async () => {
    const { page, el } = await strip({
      status: 503,
      body: { error: { code: 'x', message: 'down' } },
    });
    expect(el.getAttribute('data-tone')).toBe('zinc');
    expect(el.textContent).toContain('unavailable');
    page.unmount();
  });
});
