import { E2E_APP_URL, E2E_SEED_QUEUE } from './config';
import {
  control,
  expect,
  expectAccessible,
  expectNoBrowserErrors,
  OPERATOR,
  test,
  unlockDashboard,
  VIEWER,
} from './fixtures';

// The tick is the repair loop's heartbeat. Every spec here that stops it starts it again, so the
// next spec sees a healthy deployment.
test.beforeEach(async ({ request }) => {
  await control(request, '/tick/start');
});

test.afterEach(async ({ request }) => {
  await control(request, '/tick/start');
});

test('the Dashboard strip goes amber, then red, when the tick stops, and clears when it resumes', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page);
  const strip = page.getByTestId('status-strip');
  await expect(strip).toHaveAttribute('data-tone', 'green');
  await expect(strip).toContainText('Healthy');
  await expect(strip).toContainText(/Maintenance ran \d+s ago/);

  await control(request, '/tick/stop');
  // Late after 4 s and stale after 9 s (e2e/config.ts); the panel polls every 3 s.
  await expect(strip).toHaveAttribute('data-tone', 'amber');
  await expect(strip).toContainText('Falling behind');
  await expect(strip).toHaveAttribute('data-tone', 'red');
  await expect(strip).toContainText('Needs attention');

  // The strip says where to look; the Deployment page says what is wrong.
  await strip.click();
  await expect(page).toHaveURL(`${E2E_APP_URL}/deployment`);
  await expect(page.getByRole('heading', { name: 'Deployment', level: 1 })).toBeVisible();
  const stale = page.locator('[data-warning="tick_stale"]');
  await expect(stale).toBeVisible();
  await expect(stale).toContainText('Critical');

  await control(request, '/tick/start');
  await expect(stale).toHaveCount(0);

  await page.goBack();
  await expect(page.getByTestId('status-strip')).toHaveAttribute('data-tone', 'green');
  expectNoBrowserErrors(browserErrors);
});

test('the Job delivery page reads the local transport honestly and has no redrive button', async ({
  page,
  browserErrors,
}, testInfo) => {
  await unlockDashboard(page);
  await page.evaluate((route) => {
    window.history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `${OPERATOR.basePath}/transport`);
  await expect(page.getByRole('heading', { name: 'Job delivery', level: 1 })).toBeVisible();

  const table = page.getByRole('table', { name: 'Notification health per queue' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row', { name: new RegExp(E2E_SEED_QUEUE) })).toBeVisible();
  // The local transport has no list of failed notifications: said, not shown as a zero.
  await expect(
    page.getByText('This queue service does not keep a list of failed notifications.')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /redrive/i })).toHaveCount(0);
  await expectAccessible(page, testInfo, 'transport');
  expectNoBrowserErrors(browserErrors);
});

test('a viewer can read the Job delivery and Deployment pages', async ({ page, browserErrors }) => {
  await unlockDashboard(page, false, VIEWER);
  await page.evaluate((route) => {
    window.history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `${VIEWER.basePath}/deployment`);
  await expect(page.getByRole('heading', { name: 'Deployment', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maintenance' })).toBeVisible();

  await page.evaluate((route) => {
    window.history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `${VIEWER.basePath}/transport`);
  await expect(page.getByRole('heading', { name: 'Job delivery', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Notification health per queue' })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
