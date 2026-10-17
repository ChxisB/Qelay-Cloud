import {
  E2E_APP_URL,
  E2E_BASE_PATH,
  E2E_CONTROL_TOKEN,
  E2E_CONTROL_URL,
  E2E_SEED_QUEUE,
} from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';
import { clickNavLink } from './navigation';

test.beforeEach(async ({ page, request }) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
});

test('shows live queue metrics, storage health and the real worker registry', async ({
  page,
  browserErrors,
}) => {
  await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}/metrics"]`));
  // The Overview also lists the seed queue and shows a "Live" pill, and it stays on screen while
  // the lazy Metrics chunk loads — so wait for the page's own heading, not just the URL.
  await expect(page.getByRole('heading', { level: 1, name: 'Metrics' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: E2E_SEED_QUEUE })).toBeVisible();
  await expect(page.locator('#main').getByText('Live', { exact: true })).toBeVisible();
  await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}/usage"]`));
  await expect(page.getByText('Disk writes are being accepted.')).toBeVisible();
  await expect(page.getByText('Jobs pushed (since restart)')).toBeVisible();
  const workers = page.waitForResponse((r) => r.url().endsWith('/api/workers') && r.ok());
  await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}/workers"]`));
  expect((await (await workers).json()).data.workers).toEqual([]);
  await expect(page.getByText('No workers registered', { exact: true })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('receives a real job event in Logs and filters it', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `logs-${testInfo.project.name}`;
  await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}/logs"]`));
  await expect(page.getByRole('heading', { name: 'Activity Logs', exact: true })).toBeVisible();
  await expect(page.locator('#main').getByText('Live', { exact: true })).toBeVisible();
  await control(request, '/jobs', { queue });
  await expect(page.getByRole('row').filter({ hasText: queue })).toBeVisible();
  await page.getByRole('textbox').fill('no-matching-e2e-event');
  await expect(page.getByRole('row').filter({ hasText: queue })).toHaveCount(0);
  await page.getByRole('textbox').fill(queue);
  await expect(page.getByRole('row').filter({ hasText: queue })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('evaluates an alert against a real waiting job and removes the rule', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `alerts-${testInfo.project.name}`;
  const name = `Waiting evidence ${testInfo.project.name}`;
  await control(request, '/jobs', { queue });
  await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}/alerts"]`));
  await page.getByRole('button', { name: '+ Create Alert Rule' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Metric', { exact: true }).selectOption('waiting');
  await page.getByLabel('Threshold', { exact: true }).fill('1');
  await page.getByLabel('Queue (optional)').fill(queue);
  await page.getByRole('button', { name: 'Save rule' }).click();
  const triggered = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Triggered Alerts' }) });
  await expect(triggered.getByRole('row').filter({ hasText: name })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Delete rule ${name}` }).click();
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});

test('shows a real failed job in both DLQ views, with purge disabled and no retry offered', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `failure-${testInfo.project.name}`;
  // A job that has failed for good: claimed and failed through the store, as a worker would.
  const seeded = await request.post(`${E2E_CONTROL_URL}/seed/failed`, {
    headers: { Authorization: `Bearer ${E2E_CONTROL_TOKEN}` },
    data: { queue, name: 'expected-failure' },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = await seeded.json();
  for (const route of ['/dlq', '/dlq-control']) {
    await clickNavLink(page, page.locator(`#app-nav a[href="${E2E_BASE_PATH}${route}"]`));
    await expect(page).toHaveURL(`${E2E_APP_URL}${route}`);
    await expect(
      page.getByRole('heading', {
        name: route === '/dlq' ? 'Dead Letter Queue' : 'DLQ Control',
        exact: true,
      })
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Queue', exact: true }).selectOption(queue);
    await expect(page.getByRole('combobox', { name: 'Queue', exact: true })).toHaveValue(queue);
    await expect(
      page.getByRole('row').filter({ has: page.locator(`a[href="${E2E_BASE_PATH}/job?id=${id}"]`) })
    ).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Purge', exact: true })).toBeDisabled();
  // Retrying a dead job is not offered here: the Control API answers it with 501 (`dlq-retry`).
  await expect(page.getByRole('button', { name: 'Retry all', exact: true })).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});
