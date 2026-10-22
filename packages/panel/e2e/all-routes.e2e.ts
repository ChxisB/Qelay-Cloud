import type { Page } from '@playwright/test';
import { E2E_APP_URL, E2E_BASE_PATH, E2E_SEED_QUEUE } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

async function navigateInApp(page: Page, path: string, expectedPath = path): Promise<void> {
  await page.evaluate(
    ({ basePath, route }) => {
      window.history.pushState({}, '', `${basePath}${route}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    { basePath: E2E_BASE_PATH, route: path }
  );
  await expect(page).toHaveURL(`${E2E_APP_URL}${expectedPath}`);
}

test.beforeEach(async ({ request }) => {
  await control(request, '/upstream/start');
});

test('sends every removed classic path to its page, keeping the query string', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);

  const routes = [
    ['/overview-classic', ''],
    ['/queues-classic', '/queues'],
    [`/queues-classic/${E2E_SEED_QUEUE}?tab=jobs`, `/queues/${E2E_SEED_QUEUE}?tab=jobs`],
    ['/jobs-classic', '/jobs'],
    ['/dlq-classic', '/dlq'],
    ['/cron-classic', '/cron'],
    ['/metrics-classic', '/metrics'],
    ['/workers-classic', '/workers'],
    ['/logs-classic', '/logs'],
    ['/usage-classic', '/usage'],
  ] as const;

  for (const [path, landedAt] of routes) {
    await navigateInApp(page, path, landedAt);
    await expect(page.locator('#main h1').first()).toBeVisible();
    await expect(page.getByText('That page does not exist')).toHaveCount(0);
  }

  // S3 backup belongs to a server that holds its own database; this deployment has none.
  await navigateInApp(page, '/s3-classic', '/s3');
  await expect(page.getByText('Not available in this deployment')).toBeVisible();

  expectNoBrowserErrors(browserErrors);
});

test('redirects the legacy cron route and renders the wildcard fallback', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await navigateInApp(page, '/cron-manager', '/cron');
  await expect(page).toHaveURL(`${E2E_APP_URL}/cron`);
  await expect(page.getByRole('heading', { name: 'Cron jobs', level: 1 })).toBeVisible();

  await navigateInApp(page, '/definitely-not-a-route');
  await expect(
    page.getByRole('heading', { name: 'That page does not exist', level: 1 })
  ).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
