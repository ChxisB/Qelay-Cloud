import type { APIRequestContext, Page } from '@playwright/test';
import {
  E2E_APP_URL,
  E2E_CONTROL_TOKEN,
  E2E_CONTROL_URL,
  E2E_SERVER_TOKEN,
  E2E_VIEWER_TOKEN,
  E2E_VIEWER_URL,
} from './config';
import {
  control,
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

interface SeededFlow {
  readonly root: string;
  readonly failed: string;
  readonly fine: string;
  readonly queue: string;
  readonly name: string;
}

/** A flow whose one child failed and holds its parent in `waiting-children`, written straight to the store. */
async function seedFlow(request: APIRequestContext, queue: string): Promise<SeededFlow> {
  const name = `assemble-${queue}`;
  const response = await request.post(`${E2E_CONTROL_URL}/seed/flow`, {
    headers: { Authorization: `Bearer ${E2E_CONTROL_TOKEN}` },
    data: { queue, name },
  });
  expect(response.ok(), `seed/flow failed: ${await response.text()}`).toBe(true);
  return { ...(await response.json()), name };
}

const tree = (page: Page) => page.locator('#main').getByRole('tree');
const row = (page: Page, state: string) =>
  tree(page).locator(`[role="treeitem"][data-flow-state="${state}"]`);

async function openFlowsPage(page: Page, mount: Mount = OPERATOR): Promise<void> {
  await clickNavLink(page, page.locator(`#app-nav nav a[href="${mount.basePath}/flows"]`));
  await expect(page).toHaveURL(`${mount.appUrl}/flows`);
  await expect(
    page.locator('#main').getByRole('heading', { name: 'Job Flows', level: 1 })
  ).toBeVisible();
}

test('flow: an operator finds a stuck flow, retries its failed child, and the parent completes', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  test.setTimeout(90_000);
  const queue = `flow-e2e-${testInfo.project.name}-${testInfo.retry}`;
  const seeded = await seedFlow(request, queue);
  await unlockDashboard(page);

  // The list says which flow is stuck, and opening it shows the tree.
  await openFlowsPage(page);
  const listed = page.locator('#main tbody tr', { hasText: seeded.name });
  await expect(listed).toContainText('1 stuck');
  await listed.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`/flows\\?root=${encodeURIComponent(seeded.root)}`));
  await expect(tree(page).getByRole('treeitem')).toHaveCount(3);
  await expect(row(page, 'waiting-children')).toHaveCount(1);
  await expect(row(page, 'completed')).toHaveCount(1);
  await expect(row(page, 'failed')).toContainText('holds parent');
  await expect(row(page, 'failed')).toContainText('seeded failure');

  // The failed child is retried; the flow-scoped action carries the versions the panel saw.
  await row(page, 'failed').click();
  const retry = page.getByRole('button', { name: 'Retry this job' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator('#main').getByRole('status')).toContainText('put back on its queue');
  await expect(row(page, 'failed')).toHaveCount(0);
  await expect(row(page, 'waiting')).toHaveCount(1);

  // A worker finishes the child; the parent is released inside that transaction and finishes too.
  await control(request, '/worker/stop');
  await control(request, '/worker/start', { queue });
  try {
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(row(page, 'completed')).toHaveCount(3, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  } finally {
    await control(request, '/worker/stop');
  }
  await expect(row(page, 'waiting-children')).toHaveCount(0);

  // The mutation left one audit row naming the action and the flow.
  const audit = await request.get(`${E2E_APP_URL}/api/audit?limit=50`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(audit.ok()).toBe(true);
  const entries = (await audit.json()).entries as Array<Record<string, unknown>>;
  const mine = entries.filter(
    (entry) =>
      entry.action === 'POST /flows/:id/actions' && String(entry.target).includes(seeded.root)
  );
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ outcome: 'success', status: 200 });
  expect(String(mine[0]?.target)).toContain('flowAction=retry-failed');
  expectNoBrowserErrors(browserErrors);
});

test('flow: a viewer reads the tree, is offered no action, and the server refuses a forced one', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `flow-viewer-${testInfo.project.name}-${testInfo.retry}`;
  const seeded = await seedFlow(request, queue);
  await unlockDashboard(page, false, VIEWER);
  await goInApp(page, `/flows?root=${encodeURIComponent(seeded.root)}`, VIEWER);
  await expect(tree(page).getByRole('treeitem')).toHaveCount(3);
  await row(page, 'failed').click();
  await expect(page.locator('#main').getByText('seeded failure').first()).toBeVisible();
  await expect(
    page.locator('#main').getByText('Your role can look at flows but not change them.')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Release/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Remove flow/ })).toHaveCount(0);

  const forced = await request.post(`${E2E_VIEWER_URL}/api/flows/${seeded.root}/actions`, {
    headers: { Authorization: `Bearer ${E2E_VIEWER_TOKEN}` },
    data: { action: 'retry-failed', jobs: [{ id: seeded.failed, expectedVersion: 1 }] },
  });
  expect(forced.status()).toBe(403);
  expect((await forced.json()).error.code).toBe('forbidden');
  expectNoBrowserErrors(browserErrors);
});

test('flow: a link to a job inside a flow opens the flow at that job, and a stale root is explained', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `flow-link-${testInfo.project.name}-${testInfo.retry}`;
  const seeded = await seedFlow(request, queue);
  await unlockDashboard(page);

  // A child id given as the root is found in its flow: the address is rewritten to the real root.
  await goInApp(page, `/flows?root=${encodeURIComponent(seeded.failed)}`);
  await expect(page).toHaveURL(new RegExp(`root=${encodeURIComponent(seeded.root)}`));
  await expect(page).toHaveURL(new RegExp(`node=${encodeURIComponent(seeded.failed)}`));
  await expect(row(page, 'failed')).toHaveAttribute('aria-selected', 'true');

  // An id that is no job at all says so instead of showing an empty page.
  await goInApp(page, '/flows?root=no-such-job');
  await expect(
    page.locator('#main').getByText(/not part of a flow|not found|No flow/i)
  ).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
