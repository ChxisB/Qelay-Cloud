import type { Page } from '@playwright/test';
import {
  E2E_APP_URL,
  E2E_BASE_PATH,
  E2E_CONTROL_TOKEN,
  E2E_CONTROL_URL,
  E2E_SERVER_TOKEN,
  E2E_VIEWER_TOKEN,
  E2E_VIEWER_URL,
} from './config';
import {
  expect,
  expectNoBrowserErrors,
  goInApp,
  OPERATOR,
  test,
  unlockDashboard,
  VIEWER,
  type Mount,
} from './fixtures';
import { clickNavLink } from './navigation';

/** Add job, Bulk add and the job inspector are reached from the Jobs page, not the sidebar. */
async function openFromJobs(page: Page, link: string, route: string, heading: string) {
  await visit(page, '/jobs', OPERATOR, 'Jobs');
  await page.locator('#main').getByRole('link', { name: link, exact: true }).click();
  await expect(page).toHaveURL(`${OPERATOR.appUrl}${route}`);
  await expect(
    page.locator('#main').getByRole('heading', { name: heading, level: 1 })
  ).toBeVisible();
}

/**
 * Follows a nav link. The address changes before the lazy page has rendered, so a caller that goes
 * on to use the page names its heading and waits for that, or it would act on the previous page.
 */
async function visit(
  page: Page,
  route: string,
  mount: Mount = OPERATOR,
  heading?: string
): Promise<void> {
  await clickNavLink(page, page.locator(`#app-nav nav a[href="${mount.basePath}${route}"]`));
  await expect(page).toHaveURL(`${mount.appUrl}${route}`);
  if (heading) {
    await expect(
      page.locator('#main').getByRole('heading', { name: heading, level: 1 })
    ).toBeVisible();
  }
}

test('an operator adds a job, sees it listed, and pauses and resumes its queue', async ({
  page,
  browserErrors,
}, testInfo) => {
  const queue = `flow-${testInfo.project.name}-${testInfo.retry}`;
  await unlockDashboard(page);

  await openFromJobs(page, 'Add job', '/add-job', 'Add job');
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Job name', { exact: true }).fill('main-flow');
  await page.getByLabel('Data (JSON)').fill('{"step":"add"}');
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add job', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  expect(response.request().headers().authorization).toBe(`Bearer ${E2E_SERVER_TOKEN}`);

  await visit(page, '/jobs', OPERATOR, 'Jobs');
  await page.getByLabel('Queue', { exact: true }).selectOption(queue);
  await expect(page.getByRole('row').filter({ hasText: 'main-flow' })).toBeVisible();

  // Queue control is the Settings tab of the queue's own page.
  await goInApp(page, `/queues/${queue}?tab=settings`);
  await expect(page.getByRole('heading', { name: queue, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible();
  const isPaused = async () => {
    const response = await page.request.get(`${E2E_APP_URL}/api/queues/${queue}/paused`, {
      headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).paused;
  };
  expect(await isPaused()).toBe(true);
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause queue', exact: true })).toBeVisible();
  expect(await isPaused()).toBe(false);
  expectNoBrowserErrors(browserErrors);
});

test('a failed job is not offered a retry, and the server refuses one that is forced', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `failed-${testInfo.project.name}-${testInfo.retry}`;
  const seeded = await request.post(`${E2E_CONTROL_URL}/seed/failed`, {
    headers: { Authorization: `Bearer ${E2E_CONTROL_TOKEN}` },
    data: { queue, name: 'retry-me' },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = await seeded.json();

  await unlockDashboard(page);
  await openFromJobs(page, 'Find by ID', '/job', 'Job inspector');
  await page.getByLabel('Job ID', { exact: true }).fill(id);
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.locator('#main').getByText('seeded failure').first()).toBeVisible();
  await expect(page.locator('#main').getByRole('button', { name: /retry/i })).toHaveCount(0);

  const forced = await request.post(`${E2E_APP_URL}/api/jobs/${id}/move-to-wait`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: {},
  });
  expect(forced.status()).toBe(501);
  expect((await forced.json()).error.code).toBe('not_supported');
  expectNoBrowserErrors(browserErrors);
});

test('a page this deployment does not have says so at its address', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);
  for (const path of ['/server', '/database', '/fleet']) {
    await goInApp(page, path);
    await expect(page.locator('#main').getByText('Not available in this deployment')).toBeVisible();
    await expect(page.locator(`#app-nav nav a[href="${E2E_BASE_PATH}${path}"]`)).toHaveCount(0);
  }
  expectNoBrowserErrors(browserErrors);
});

test('a viewer reads everything and changes nothing, and the server agrees', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `viewer-${testInfo.project.name}-${testInfo.retry}`;
  await unlockDashboard(page, false, VIEWER);
  await expect(page.locator(`#app-nav nav a[href="${VIEWER.basePath}/add-job"]`)).toHaveCount(0);
  await visit(page, '/jobs', VIEWER);
  await expect(page.getByRole('link', { name: 'Add job' })).toHaveCount(0);

  await goInApp(page, '/add-job', VIEWER);
  await expect(page.locator('#main').getByText('Operator role needed')).toBeVisible();

  // Reading works with the viewer's credential; writing is refused by the server, not just hidden.
  const headers = { Authorization: `Bearer ${E2E_VIEWER_TOKEN}` };
  expect((await request.get(`${E2E_VIEWER_URL}/api/queues/summary`, { headers })).status()).toBe(
    200
  );
  const forced = await request.post(`${E2E_VIEWER_URL}/api/queues/${queue}/jobs`, {
    headers,
    data: { name: 'not-allowed', data: {} },
  });
  expect(forced.status()).toBe(403);
  expect((await forced.json()).error.code).toBe('forbidden');
  expectNoBrowserErrors(browserErrors);
});

test('the credential is kept in memory: not in storage, the address or the console', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(message.text()));
  await unlockDashboard(page);
  await visit(page, '/queues');
  await visit(page, '/jobs');
  await visit(page, '/settings');

  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage).flat().join('\n'),
    session: Object.entries(sessionStorage).flat().join('\n'),
    cookie: document.cookie,
    href: location.href,
  }));
  for (const [where, text] of Object.entries(stored)) {
    expect(text, `the token is in ${where}`).not.toContain(E2E_SERVER_TOKEN);
  }
  expect(logged.join('\n')).not.toContain(E2E_SERVER_TOKEN);
});
