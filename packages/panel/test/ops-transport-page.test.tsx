import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { Transport } from '../src/pages/control/Transport';
import { settle } from './domSetup';
import { installOpsHooks, mountRouted, queue, serveOps, serveRole, transport } from './ops.helpers';
import { rowFor, show } from './transportPage.helpers';

installOpsHooks();

describe('the Transport page: doorbell health', () => {
  test('puts the store and the broker side by side and says how old the broker figures are', async () => {
    const { page } = await show(
      transport([
        queue('emails', {
          doorbellDepth: 14,
          oldestUndeliveredAgeMs: 8_000,
          store: { claimable: 20, notRung: 0, reRingDue: 0 },
        }),
      ])
    );
    const row = rowFor(page.host, 'emails');
    expect(row).toContain('20');
    expect(row).toContain('14');
    expect(row).toContain('8s');
    expect(row).toContain('45s ago, up to 5m behind');
    page.unmount();
  });

  test('says in words what a big "no doorbell" count means', async () => {
    const { page } = await show(
      transport([
        queue('slow', { store: { claimable: 40, notRung: 40, oldestNotRungAgeMs: 120_000 } }),
      ])
    );
    expect(rowFor(page.host, 'slow')).toContain('maintenance is behind');
    page.unmount();
  });

  test('says in words what a deep dead-letter queue means', async () => {
    const { page } = await show(
      transport([queue('orders', { deadLetterDepth: 3, deadLetterOldestAgeMs: 600_000 })])
    );
    const row = rowFor(page.host, 'orders');
    expect(row).toContain('3 failed notifications');
    expect(row).toContain('oldest 10m');
    page.unmount();
  });

  test('a backlog is called normal, not an alarm', async () => {
    const { page } = await show(
      transport([queue('bulk', { doorbellDepth: 900, store: { claimable: 900, reRingDue: 880 } })])
    );
    expect(rowFor(page.host, 'bulk')).toContain('Normal for a backlog');
    page.unmount();
  });

  test('a depth the broker did not give is "unknown", never 0', async () => {
    const { page } = await show(
      transport([
        queue('mystery', {
          doorbellDepth: null,
          oldestUndeliveredAgeMs: null,
          deadLetterDepth: null,
          freshness: { observedAt: null, ageMs: null, maxStalenessMs: 0, source: 'unavailable' },
        }),
      ])
    );
    const row = rowFor(page.host, 'mystery');
    expect(row).toContain('unknown');
    expect(row).toContain('not read');
    expect(row).toContain('The queue service did not answer');
    // Three broker columns, all unknown.
    expect(row.match(/unknown/g)!.length).toBeGreaterThanOrEqual(3);
    page.unmount();
  });

  test('a count stopped at its cap is shown as "or more"', async () => {
    const { page } = await show(
      transport([queue('huge', { store: { claimable: 1000, capped: true, reRingDue: 1000 } })])
    );
    expect(rowFor(page.host, 'huge')).toContain('1,000+');
    page.unmount();
  });

  test('a paused queue is said to be held on purpose', async () => {
    const { page } = await show(
      transport([queue('held', { store: { paused: true, claimable: 5 } })])
    );
    expect(rowFor(page.host, 'held')).toContain('held on purpose');
    page.unmount();
  });

  test('says when more queues exist than are listed', async () => {
    const { page } = await show(transport([queue('a'), queue('b')], { truncated: true }));
    expect(page.text()).toContain('More queues exist than are shown');
    page.unmount();
  });

  test('shows the transport and what it can do', async () => {
    const { page } = await show(
      transport([queue('a')], {
        transport: { name: 'gcp-pubsub', maxDeliverDelayMs: 0, ordering: 'none' },
      })
    );
    expect(page.text()).toContain('gcp-pubsub');
    expect(page.text()).toContain('cannot hold a notification back');
    expect(page.text()).toContain('No ordering');
    page.unmount();
  });

  test('explains how to read it, including that cloud metrics lag', async () => {
    const { page } = await show(transport([queue('a')]));
    expect(page.text()).toContain('Cloud metrics lag by minutes');
    page.unmount();
  });

  test('no queues is an empty state, not a table of zeros', async () => {
    const { page } = await show(transport([]));
    expect(page.text()).toContain('No queues yet');
    expect(page.host.querySelector('table')).toBeNull();
    page.unmount();
  });

  test('a server with no jobs routes is an error, not an empty page', async () => {
    serveOps({
      '/transport': {
        status: 501,
        body: { error: { code: 'not_implemented', message: 'no jobs' } },
      },
    });
    const page = mountRouted(createElement(Transport), '/transport');
    await settle(80);
    expect(page.text()).toContain('unavailable');
    page.unmount();
  });
});

const POISON = transport([queue('orders', { deadLetterDepth: 2 })]);
const SAMPLE = {
  ok: true,
  queue: 'orders',
  available: true,
  reason: null,
  timestamp: 1,
  items: [
    {
      jobId: 'job-live',
      queue: 'orders',
      deliveryCount: 5,
      deadLetteredAt: 1,
      ageMs: 120_000,
      jobExists: true,
    },
    {
      jobId: 'job-gone',
      queue: 'orders',
      deliveryCount: null,
      deadLetteredAt: null,
      ageMs: null,
      jobExists: false,
    },
    {
      jobId: null,
      queue: 'orders',
      deliveryCount: 5,
      deadLetteredAt: 1,
      ageMs: 5_000,
      jobExists: false,
    },
  ],
};

describe('the Transport page: poison doorbells', () => {
  test('an operator sees recent poison doorbells and links only the jobs that exist', async () => {
    const { page, seen } = await show(POISON, { '/transport/dead-letters': SAMPLE });
    expect(seen.some((path) => path.startsWith('/transport/dead-letters?queue=orders'))).toBe(true);
    const links = [...page.host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/job?id=job-live');
    expect(links.some((href) => href?.includes('job-gone'))).toBe(false);
    expect(page.text()).toContain('job-gone');
    expect(page.text()).toContain('unreadable notification');
    expect(page.text()).toContain('2m ago');
    page.unmount();
  });

  test('has no redrive, retry or purge button: redriving is a runbook step', async () => {
    const { page } = await show(POISON, { '/transport/dead-letters': SAMPLE });
    const controls = [...page.host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(controls.filter((label) => /redrive|retry|purge|delete|requeue/i.test(label))).toEqual(
      []
    );
    expect(page.text()).toContain('redrive runbook');
    page.unmount();
  });

  test('a viewer is told it is for operators and no request reads the broker', async () => {
    serveRole('viewer');
    const { page, seen } = await show(POISON, { '/transport/dead-letters': SAMPLE });
    expect(page.text()).toContain('for operators');
    expect(seen.some((path) => path.startsWith('/transport/dead-letters'))).toBe(false);
    // The depth is still on the page: it is not a secret.
    expect(rowFor(page.host, 'orders')).toContain('2 failed notifications');
    page.unmount();
  });

  test('a transport without a dead-letter queue says so and asks nothing', async () => {
    const { page, seen } = await show(
      transport([queue('local', { deadLetterDepth: null })], {
        transport: { name: 'local', maxDeliverDelayMs: null, ordering: 'best-effort' },
        deadLetter: { supported: false },
      }),
      { '/transport/dead-letters': SAMPLE }
    );
    expect(page.text()).toContain('does not keep a list of failed notifications');
    expect(seen.some((path) => path.startsWith('/transport/dead-letters'))).toBe(false);
    page.unmount();
  });

  test('an unreachable broker is "unknown", not an empty list', async () => {
    const { page } = await show(POISON, {
      '/transport/dead-letters': { ...SAMPLE, available: false, reason: 'unreachable', items: [] },
    });
    expect(page.text()).toContain('unknown (not none)');
    expect(page.text()).not.toContain('No failed notifications in orders');
    page.unmount();
  });

  test('an empty dead-letter queue is said to be empty', async () => {
    const { page } = await show(POISON, {
      '/transport/dead-letters': { ...SAMPLE, items: [] },
    });
    expect(page.text()).toContain('No failed notifications in orders');
    page.unmount();
  });
});
