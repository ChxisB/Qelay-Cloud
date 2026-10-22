import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import type { DeploymentView } from '../src/lib/ops/types';
import { Deployment } from '../src/pages/control/Deployment';
import { settle } from './domSetup';
import { deployment, installOpsHooks, mountRouted, serveOps } from './ops.helpers';

installOpsHooks();

async function show(body: DeploymentView) {
  serveOps({ '/deployment': body });
  const page = mountRouted(createElement(Deployment), '/deployment');
  await settle(80);
  return page;
}

const warn = (code: string, severity: 'warning' | 'critical', message: string) => ({
  code,
  severity,
  message,
});

describe('the Deployment page', () => {
  test('a healthy deployment says there are no warnings and shows the build', async () => {
    const page = await show(deployment());
    expect(page.text()).toContain('No warnings');
    expect(page.text()).toContain('1.0.0');
    expect(page.text()).toContain('a1b2c3d');
    expect(page.text()).toContain('Production');
    expect(page.host.querySelector('[data-warning]')).toBeNull();
    page.unmount();
  });

  test.each([
    ['tick_late', 'warning', 'The tick last ran 90s ago.'],
    ['tick_stale', 'critical', 'The tick has not run for 12m: no job is being repaired.'],
    ['tick_never_ran', 'critical', 'The tick has never run against this database.'],
    ['tick_unknown', 'warning', 'No tick is reporting to this server.'],
    ['schema_ahead', 'critical', 'The database is at migration 6 and this build expects 5.'],
    ['schema_behind', 'warning', 'The database is at migration 4 and this build expects 5.'],
    ['database_unreachable', 'critical', 'The database did not answer.'],
    ['transport_unreachable', 'warning', 'The transport did not answer.'],
    ['connections_high', 'warning', '90 of 100 connections are in use.'],
    ['connections_exhausted', 'critical', 'All 100 connections are in use.'],
    ['connection_budget_exceeded', 'warning', 'The declared fleet needs 140 of 100.'],
    ['doorbells_overdue', 'warning', '40 claimable jobs have no doorbell.'],
    ['dev_token_enabled', 'warning', 'The development token is enabled.'],
  ] as const)(
    "shows %s with its severity and the server's words",
    async (code, severity, message) => {
      const page = await show(deployment({ warnings: [warn(code, severity, message)] }));
      const item = page.host.querySelector(`[data-warning="${code}"]`);
      expect(item).not.toBeNull();
      expect(item!.textContent).toContain(message);
      // The severity is a word, not only a colour.
      expect(item!.textContent).toContain(severity === 'critical' ? 'Critical' : 'Warning');
      expect(item!.getAttribute('role')).toBe(severity === 'critical' ? 'alert' : 'status');
      expect(page.text()).not.toContain('No warnings');
      page.unmount();
    }
  );

  test('lists critical warnings before ordinary ones', async () => {
    const page = await show(
      deployment({
        warnings: [
          warn('dev_token_enabled', 'warning', 'dev token'),
          warn('tick_stale', 'critical', 'tick stalled'),
        ],
      })
    );
    const order = [...page.host.querySelectorAll('[data-warning]')].map((el) =>
      el.getAttribute('data-warning')
    );
    expect(order).toEqual(['tick_stale', 'dev_token_enabled']);
    page.unmount();
  });

  test.each([
    ['late', 'Late'],
    ['stale', 'Stalled'],
    ['never', 'Has not run since this server started'],
    ['unknown', 'no maintenance run is reporting'],
  ] as const)('a tick that is %s says so in the Tick card', async (state, words) => {
    const page = await show(
      deployment({ tick: { ...deployment().tick, state, lastSuccessAt: null, ageMs: null } })
    );
    expect(page.text()).toContain(words);
    page.unmount();
  });

  test('a schema ahead of this build is named, with both numbers', async () => {
    const page = await show(deployment({ schema: { current: 6, expected: 5, state: 'ahead' } }));
    expect(page.text()).toContain('Ahead of this build');
    expect(page.text()).toContain('6 recorded, 5 expected');
    page.unmount();
  });

  test('a figure the server could not read is "unknown", never 0', async () => {
    const page = await show(
      deployment({
        connections: { inUse: null, maxConnections: null, needed: null, mode: null },
        workers: { total: null, active: null },
        database: { state: 'unknown', latencyMs: null },
        doorbells: { notRung: null, oldestNotRungAgeMs: null, queuesScanned: null, partial: false },
      })
    );
    const text = page.text();
    expect(text).toContain('unknown of unknown');
    expect(text).toMatch(/Registered\s*unknown/);
    expect(text).toMatch(/Response time\s*unknown/);
    expect(text).toMatch(/Ready but not notified\s*unknown/);
    expect(text).not.toMatch(/Registered\s*0/);
    page.unmount();
  });

  test('says when only some queues were scanned', async () => {
    const page = await show(
      deployment({
        doorbells: { notRung: 7, oldestNotRungAgeMs: 90_000, queuesScanned: 50, partial: true },
      })
    );
    expect(page.text()).toContain('partial');
    page.unmount();
  });

  test('has nothing to press: it is read-only', async () => {
    const page = await show(deployment({ warnings: [warn('tick_late', 'warning', 'late')] }));
    const controls = [...page.host.querySelectorAll('button')].map((b) => b.textContent);
    expect(controls).toEqual([]);
    page.unmount();
  });

  test('an unreachable server is an error with a retry, not an empty page', async () => {
    serveOps({
      '/deployment': { status: 503, body: { error: { code: 'unavailable', message: 'down' } } },
    });
    const page = mountRouted(createElement(Deployment), '/deployment');
    await settle(80);
    expect(page.text()).toContain('unavailable');
    expect(page.text()).not.toContain('No warnings');
    page.unmount();
  });

  test('an answer it does not understand is refused, not guessed at', async () => {
    serveOps({ '/deployment': { ok: true, version: 3 } });
    const page = mountRouted(createElement(Deployment), '/deployment');
    await settle(80);
    expect(page.text()).toContain('not understood');
    page.unmount();
  });
});
