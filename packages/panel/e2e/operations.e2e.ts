import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_APP_URL, E2E_SERVER_TOKEN, E2E_VERSION } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';
import { clickNavLink } from './navigation';

async function visit(page: Page, route: string): Promise<void> {
  await clickNavLink(page, page.locator(`#app-nav nav a[href="/e2e/dashboard${route}"]`));
  await expect(page).toHaveURL(`${E2E_APP_URL}${route}`);
}

/** Add job, Bulk add and the job inspector are reached from the Jobs page, not the sidebar. */
async function openFromJobs(
  page: Page,
  link: string,
  route: string,
  heading: string
): Promise<void> {
  await visit(page, '/jobs');
  await page.locator('#main').getByRole('link', { name: link, exact: true }).click();
  await expect(page).toHaveURL(`${E2E_APP_URL}${route}`);
  // The address changes before the lazy page renders; wait for its heading so a field is not found on the old page.
  await expect(
    page.locator('#main').getByRole('heading', { name: heading, level: 1 })
  ).toBeVisible();
}

async function read(request: APIRequestContext, path: string) {
  const response = await request.get(`${E2E_APP_URL}/api${path}`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
});

test('enqueues from Add Job, inspects persisted data and imports a real bulk', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `operations-${testInfo.project.name}-${testInfo.retry}`;
  await openFromJobs(page, 'Add job', '/add-job', 'Add job');
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Job name', { exact: true }).fill('verified-job');
  await page.getByLabel('Data (JSON)').fill('{"evidence":"browser-persisted","amount":42}');
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add job', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const id = String(body.id);
  expect(id).not.toBe('undefined');
  await expect(page.getByText(`Accepted job ID ${id}`, { exact: false })).toBeVisible();
  const persisted = await read(request, `/jobs/${id}`);
  expect(persisted.job.data).toEqual({ evidence: 'browser-persisted', amount: 42 });

  await visit(page, '/queues');
  // The list is paged (15 a page, by name) and every spec of both browsers adds queues to the one
  // store, so this queue is on a later page once enough queues sort before it. Filter, do not page.
  await page.getByLabel('Filter queues', { exact: true }).fill(queue);
  await expect(page.getByRole('link', { name: queue, exact: true })).toBeVisible();
  await page.getByRole('link', { name: queue, exact: true }).click();
  await expect(page.getByRole('heading', { name: queue, exact: true })).toBeVisible();
  await openFromJobs(page, 'Find by ID', '/job', 'Job inspector');
  await page.getByLabel('Job ID', { exact: true }).fill(id);
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(
    page.locator('#main').getByText('browser-persisted', { exact: false })
  ).toBeVisible();

  await openFromJobs(page, 'Bulk add', '/jobs/bulk-add', 'Bulk add jobs');
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Jobs JSON').fill(
    JSON.stringify([
      { name: 'bulk-one', data: { n: 1 } },
      { name: 'bulk-two', data: { n: 2 } },
    ])
  );
  const imported = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs/bulk`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /Import/u }).click();
  expect((await imported).ok()).toBe(true);
  await expect
    .poll(async () => (await read(request, `/queues/${queue}/counts`)).counts.waiting)
    .toBe(3);
  expectNoBrowserErrors(browserErrors);
});

test('reads live diagnostics', async ({ page, browserErrors }) => {
  await visit(page, '/deployment');
  await page
    .getByRole('navigation', { name: 'Health' })
    .getByRole('link', { name: 'Diagnostics', exact: true })
    .click();
  await expect(page).toHaveURL(`${E2E_APP_URL}/diagnostics`);
  await expect(page.getByText(`v${E2E_VERSION}`, { exact: true })).toBeVisible();
  const ping = page.waitForResponse((r) => r.url().endsWith('/api/ping'));
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  expect((await ping).ok()).toBe(true);
  await expect(page.getByRole('button', { name: /Ping ·/u })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
