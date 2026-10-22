import { readFileSync } from 'node:fs';
import { Link, Route, Routes } from 'react-router-dom';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { ConnectionPage } from '../src/pages/control/gateway/ConnectionPage';
import {
  PAUSE_AFTER,
  RATE_PER_MINUTE,
  RETRY_WORDS,
} from '../src/pages/control/gateway/connectionRules';
import { asViewer, at, route, serveGateway } from './gateway.helpers';
import {
  createElement,
  describe,
  expect,
  installTestHooks,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

const BASE = '/events-gateway/connections';
const settings = (path: string) =>
  at(
    path,
    createElement(
      'div',
      null,
      createElement(Link, { to: `${BASE}/hook-2/settings` }, 'next'),
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: `${BASE}/:id/settings`,
          element: createElement(ConnectionPage, { tab: 'settings' }),
        }),
        createElement(Route, { path: '/events-gateway', element: createElement('p', null, 'list') })
      ),
      // After the page, so its buttons come first while the dialog is still leaving.
      createElement(ConfirmDialog)
    )
  );

describe('Connection settings: rules', () => {
  test('a viewer reads the rules in the order an event meets them, with the filter and shape written out', async () => {
    asViewer();
    serveGateway([
      route({
        filter: { queue: { $startsWith: 'bill' } },
        shape: { text: 'Job failed' },
        delayMs: 90_000,
        dedupe: { windowMs: 3_600_000, fields: ['event', 'jobId'] },
      }),
    ]);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    const items = [...view.host.querySelectorAll('ol li')].map((item) => item.textContent ?? '');
    expect(items.map((text) => text.split(/On|Off/)[0]?.trim())).toEqual([
      'Filter',
      'Deduplicate',
      'Shape',
      'Delay',
      'Rate limit',
      'Retry',
      'Auto-pause',
    ]);
    expect(items[0]).toContain('$startsWith');
    expect(items[1]).toContain('event, jobId within 1 hour');
    expect(items[2]).toContain('Job failed');
    expect(items[3]).toContain('waits 90 seconds');
    expect(items[4]).toContain(`${RATE_PER_MINUTE} attempts a minute`);
    expect(items[5]).toContain(RETRY_WORDS);
    expect(items[6]).toContain(`${PAUSE_AFTER} failed events in a row`);
    view.unmount();
  });

  test('a viewer sees a connection with no rules as all off, and nothing to press', async () => {
    asViewer();
    serveGateway([route()]);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    const items = [...view.host.querySelectorAll('ol li')].map((item) => item.textContent ?? '');
    for (const index of [0, 1, 2, 3]) expect(items[index]).toContain('Off');
    expect(view.host.querySelector('ol pre')).toBeNull();
    expect(view.host.querySelectorAll('button')).toHaveLength(0);
    expect(view.host.querySelector('textarea, input')).toBeNull();
    view.unmount();
  });

  test('an operator edits the rules in a form and the list keeps only what is the same for every connection', async () => {
    serveGateway([route({ filter: { queue: 'emails' } })]);
    const view = settings(`${BASE}/hook-1/settings`);
    await settle(20);
    const items = [...view.host.querySelectorAll('ol li')].map((item) => item.textContent ?? '');
    expect(items.map((text) => text.split(/On|Off/)[0]?.trim())).toEqual([
      'Rate limit',
      'Retry',
      'Auto-pause',
    ]);
    const filter = view.host.querySelector<HTMLTextAreaElement>('textarea[id]')!;
    expect(view.host.textContent).not.toContain('fixed when a connection is created');
    expect(view.host.querySelectorAll('textarea').length).toBeGreaterThanOrEqual(3);
    expect(
      [...view.host.querySelectorAll('textarea')].some((t) => t.value.includes('"queue"'))
    ).toBe(true);
    expect(filter).not.toBeNull();
    view.unmount();
  });

  test('the retry, rate and pause words are the sender defaults the webhooks guide documents', () => {
    const guide = readFileSync(new URL('../../../docs/webhooks.md', import.meta.url), 'utf8');
    expect(guide).toContain('30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m, up to **8 attempts**');
    expect(RETRY_WORDS).toContain('30 seconds, then 1, 2, 4, 8, 16 and 32 minutes');
    expect(RETRY_WORDS).toContain('8 attempts');
    expect(guide).toMatch(
      new RegExp(`QCLOUD_WEBHOOK_RATE_PER_MINUTE\` \\| .* \\| ${RATE_PER_MINUTE} \\|`)
    );
    expect(guide).toMatch(
      new RegExp(`QCLOUD_WEBHOOK_DISABLE_AFTER\` \\| .* \\| ${PAUSE_AFTER} \\|`)
    );
  });
});
