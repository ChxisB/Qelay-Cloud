import {
  CronManager,
  createElement,
  DlqPro,
  describe,
  expect,
  installTestHooks,
  JobsPro,
  MemoryRouter,
  OverviewPro,
  type ReactElement,
  render,
  S3BackupPro,
  settle,
  test,
  UsagePro,
} from './async-ui-state-fixes.helpers';

installTestHooks();

describe('initial polling failures are not rendered as healthy or empty data', () => {
  const cases: Array<[string, () => ReactElement, string]> = [
    [
      'overview',
      () => createElement(MemoryRouter, null, createElement(OverviewPro)),
      'StorageHealthy',
    ],
    [
      'cron list',
      () => createElement(MemoryRouter, null, createElement(CronManager)),
      'No scheduled jobs',
    ],
    ['storage', () => createElement(MemoryRouter, null, createElement(S3BackupPro)), 'DiskHealthy'],
  ];

  for (const [name, element, falseClaim] of cases) {
    test(`${name} shows an error state without a green Live badge or false claim`, async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({ error: 'server unavailable' }, { status: 502 })
        )) as typeof fetch;
      const { host, unmount } = render(element());
      await settle(10);

      expect(host.textContent).toContain('server unavailable');
      expect(host.textContent?.replace(/\s+/g, '')).not.toContain(falseClaim);
      expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
        false
      );
      unmount();
    });
  }

  test('the pro usage page also rejects missing disk-health data', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/storage')) return Promise.resolve(Response.json({ ok: true, data: {} }));
      if (url.endsWith('/queues/summary')) return Promise.resolve(Response.json([]));
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, null, createElement(UsagePro)));
    await settle(10);

    expect(host.textContent).toContain('missing disk health data');
    expect(host.textContent).not.toContain('Disk writes are being accepted');
    unmount();
  });

  test('DLQ discovery keeps totals unknown instead of publishing a synthetic zero', async () => {
    let finishDiscovery!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishDiscovery = resolve;
      })) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, null, createElement(DlqPro)));
    await settle(10);

    expect(host.textContent).toContain('Discovering queues');
    expect(host.textContent?.replace(/\s+/g, '')).not.toContain('DLQEntries0');
    finishDiscovery(Response.json({ ok: true, queues: [], total: 0 }));
    await settle(10);
    unmount();
  });

  test('JobsPro does not claim Live or an empty job page while queue discovery is pending', async () => {
    let finishDiscovery!: (response: Response) => void;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).endsWith('/queues/summary')) {
        return new Promise<Response>((resolve) => {
          finishDiscovery = resolve;
        });
      }
      return Promise.resolve(
        Response.json({
          ok: true,
          stats: { completed: 0, waiting: 0, active: 0, delayed: 0 },
        })
      );
    }) as typeof fetch;
    const { host, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs'] }, createElement(JobsPro))
    );
    await settle(10);

    expect(host.textContent).toContain('Discovering queues');
    expect(host.textContent).not.toContain('No jobs found');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    finishDiscovery(Response.json([]));
    await settle(10);
    unmount();
  });
});
