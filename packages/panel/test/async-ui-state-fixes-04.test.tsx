import {
  CronManager,
  createElement,
  describe,
  expect,
  installTestHooks,
  MemoryRouter,
  OverviewPro,
  type ReactElement,
  render,
  S3BackupPro,
  settle,
  test,
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
});
