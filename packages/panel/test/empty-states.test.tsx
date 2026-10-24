import { EmptyState } from '../src/components/ui/feedback';
import { ClockDrawing } from '../src/components/ui/illustrations';
import { CronManager } from '../src/pages/control/CronManager';
import {
  ConnectionsPage,
  createElement,
  DlqPro,
  dashboardQueue,
  describe,
  expect,
  installTestHooks,
  json,
  MemoryRouter,
  render,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

/** The picture is drawn, hidden from assistive technology, and the title is the only heading-like text. */
const picture = (host: HTMLElement) => host.querySelector('span[aria-hidden="true"] > svg');

const serve = (routes: Record<string, unknown>) => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([part]) => url.includes(part));
    return Promise.resolve(
      hit ? json(hit[1]) : json({ ok: false, error: `Unexpected ${url}` }, 500)
    );
  }) as typeof fetch;
};

describe('teaching empty states', () => {
  test('the picture slot replaces the icon badge and stays out of the accessibility tree', () => {
    const { host } = render(
      createElement(EmptyState, {
        icon: createElement('svg', { id: 'icon' }),
        picture: createElement(ClockDrawing),
        title: 'No schedules yet',
        headingLevel: 2,
      })
    );
    expect(host.querySelector('#icon')).toBeNull();
    expect(picture(host)).not.toBeNull();
    expect(host.querySelectorAll('h2')).toHaveLength(1);
  });

  test('an empty Cron page says what a schedule is, and its form is already open', async () => {
    serve({ '/crons': { ok: true, crons: [] } });
    const view = render(createElement(CronManager));
    await settle(10);
    expect(view.host.textContent).toContain('No schedules yet');
    expect(view.host.textContent).toContain('adds a job to a queue by itself');
    expect(picture(view.host)).not.toBeNull();
    expect(view.host.querySelector('[name="cron-name"]')).not.toBeNull();
    view.unmount();
  });

  test('an empty Connections page says what a connection is', async () => {
    serve({ '/webhooks': { ok: true, data: { webhooks: [] } } });
    const view = render(createElement(ConnectionsPage));
    await settle(10);
    expect(view.host.textContent).toContain('No connections yet');
    expect(view.host.textContent).toContain('requests of an inbound source to an address of yours');
    expect(picture(view.host)).not.toBeNull();
    view.unmount();
  });

  test('an empty dead letter queue says nothing has failed', async () => {
    serve({
      '/dashboard/queues?': {
        ok: true,
        queues: [dashboardQueue('q1', 0)],
        total: 1,
        limit: 500,
        offset: 0,
        timestamp: Date.now(),
      },
      '/dlq/stats': { ok: true, stats: { byReason: {}, pendingRetry: 0 } },
      '/dlq?': { ok: true, entries: [], total: 0 },
    });
    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/dlq?queue=q1'] }, createElement(DlqPro))
    );
    await settle(30);
    expect(view.host.textContent).toContain('Nothing has failed');
    expect(view.host.textContent).toContain('used all its tries');
    expect(picture(view.host)).not.toBeNull();
    view.unmount();
  });
});
