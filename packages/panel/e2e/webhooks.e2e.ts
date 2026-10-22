import type { Page } from '@playwright/test';
import {
  expect,
  expectNoBrowserErrors,
  OPERATOR,
  openCreateForm,
  test,
  unlockDashboard,
  VIEWER,
} from './fixtures';
import { clickNavLink } from './navigation';

const main = (page: Page) => page.locator('#main');
// The history is a table inside the expanded row of the webhooks table.
const deliveries = (page: Page) =>
  main(page).locator('table table tbody tr', { hasText: 'webhook.test' });

async function openWebhooksPage(page: Page): Promise<void> {
  await clickNavLink(page, page.locator(`#app-nav nav a[href="${OPERATOR.basePath}/webhooks"]`));
  await expect(page).toHaveURL(`${OPERATOR.appUrl}/webhooks`);
  await expect(main(page).getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible();
}

test('webhook: an operator adds a signed webhook, sends a test event, sees it pending, and removes it', async ({
  page,
  browserErrors,
}, testInfo) => {
  const url = `https://receiver.example/hook-${testInfo.project.name}-${testInfo.retry}`;
  await unlockDashboard(page);
  await openWebhooksPage(page);

  // A generated secret is shown while the webhook is being added, so it can be copied, and
  // never again: the list says only that deliveries are signed.
  await openCreateForm(page, 'New webhook');
  await main(page).getByLabel('URL', { exact: true }).fill(url);
  await main(page).getByRole('button', { name: 'Generate a signing secret' }).click();
  const secret = await main(page).getByLabel('Signing secret (optional)').inputValue();
  expect(secret).toMatch(/^[0-9a-f]{64}$/u);
  await main(page).getByRole('button', { name: 'Add webhook' }).click();
  const listed = main(page).locator('tbody tr', { hasText: url });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText('signed');
  expect(await page.content()).not.toContain(secret);
  // The form closed with the create; opened again it is empty, so the secret was not kept.
  await openCreateForm(page, 'New webhook');
  await expect(main(page).getByLabel('Signing secret (optional)')).toHaveValue('');

  // The history opens empty; a test event becomes one pending delivery for this webhook.
  await listed.getByRole('button', { name: 'Show deliveries' }).click();
  await expect(main(page).getByText('No deliveries')).toBeVisible();
  await main(page).getByRole('button', { name: 'Send test event' }).click();
  const delivery = deliveries(page);
  await expect(delivery).toHaveCount(1);
  await expect(delivery).toContainText('pending');
  await expect(delivery).toContainText('webhook-test');
  expect(await page.content()).not.toContain(secret);

  // A pending delivery offers no retry; the filter narrows the history to the status asked for.
  await expect(delivery.getByRole('button', { name: /Retry delivery/ })).toHaveCount(0);
  await main(page).getByRole('button', { name: 'Failed', exact: true }).click();
  await expect(deliveries(page)).toHaveCount(0);
  await main(page).getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(deliveries(page)).toHaveCount(1);

  // Removing asks first, then the row is gone.
  page.once('dialog', (dialog) => void dialog.accept());
  await listed.getByRole('button', { name: 'Remove webhook' }).click();
  await expect(main(page).locator('tbody tr', { hasText: url })).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});

test('webhook: a viewer is not offered the Webhooks page', async ({ page, browserErrors }) => {
  await unlockDashboard(page, false, VIEWER);
  await expect(page.locator(`#app-nav nav a[href="${VIEWER.basePath}/webhooks"]`)).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});
