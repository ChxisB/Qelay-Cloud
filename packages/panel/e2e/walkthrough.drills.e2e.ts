/**
 * The walkthrough's read-only and failure drills (task 37): a viewer who can read every page and
 * change nothing, and a worker that stops and comes back.
 */
import { E2E_VIEWER_TOKEN, E2E_VIEWER_URL, E2E_WORKER_NAME } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard, VIEWER } from './fixtures';
import { go, post, read, stateOf } from './walkthroughKit';

test.beforeEach(async ({ request }) => {
  await control(request, '/upstream/start');
  await control(request, '/tick/start');
});

test.afterEach(async ({ request }) => {
  await control(request, '/worker/stop');
});

test('a viewer reads every page and changes nothing: absent in the panel, refused by the server', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `walk-viewer-${testInfo.project.name}-${testInfo.retry}`;
  await unlockDashboard(page, false, VIEWER);
  for (const route of ['/jobs', '/dlq', '/cron', '/workers', '/transport', '/deployment']) {
    await go(page, route, VIEWER);
    await expect(page.locator('#main h1').first()).toBeVisible();
  }
  for (const route of ['/add-job', '/jobs/bulk-add']) {
    await go(page, route, VIEWER);
    await expect(page.locator('#main').getByText('Operator role needed')).toBeVisible();
  }
  await go(page, '/cron', VIEWER);
  await expect(page.getByRole('button', { name: 'New schedule' })).toHaveCount(0);

  const headers = { Authorization: `Bearer ${E2E_VIEWER_TOKEN}` };
  const attempts: Array<[string, string, unknown]> = [
    ['POST', `/queues/${queue}/jobs`, { name: 'x', data: {} }],
    ['POST', `/queues/${queue}/pause`, {}],
    ['POST', `/queues/${queue}/resume`, {}],
    ['POST', `/queues/${queue}/dlq/purge`, { confirm: queue }],
    ['POST', '/crons', { name: 'x', queue, repeatEvery: 60_000 }],
    ['DELETE', '/crons/x', undefined],
  ];
  for (const [method, path, data] of attempts) {
    const response = await request.fetch(`${E2E_VIEWER_URL}/api${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { data }),
    });
    expect([method, path, response.status()]).toEqual([method, path, 403]);
    expect((await response.json()).error.code).toBe('forbidden');
  }
  expectNoBrowserErrors(browserErrors);
});

test('drill: a stopped worker leaves its jobs waiting, and the panel shows the backlog and no worker', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  test.setTimeout(60_000);
  const queue = `walk-drill-${testInfo.project.name}-${testInfo.retry}`;
  await control(request, '/worker/start', { queue });
  await unlockDashboard(page);
  await go(page, '/workers');
  await expect(page.locator('#main').getByText(E2E_WORKER_NAME).first()).toBeVisible();

  await control(request, '/worker/stop');
  const ids: string[] = [];
  for (let n = 0; n < 3; n += 1) {
    ids.push(
      String((await post(request, `/queues/${queue}/jobs`, { name: 'wait', data: {} })).body.id)
    );
  }
  await page.waitForTimeout(2_000);
  for (const id of ids) expect(await stateOf(request, id)()).toBe('waiting');
  expect((await read(request, `/queues/${queue}/counts`)).body.counts.waiting).toBe(3);

  // The registry row of a closed worker is gone: the page says there is no worker.
  await expect.poll(async () => (await read(request, '/workers')).body.data.workers).toEqual([]);
  await go(page, '/workers');
  await expect(page.getByText('No workers registered', { exact: true })).toBeVisible();

  // A worker comes back and takes the backlog.
  await control(request, '/worker/start', { queue });
  for (const id of ids)
    await expect.poll(stateOf(request, id), { timeout: 20_000 }).toBe('completed');
  expectNoBrowserErrors(browserErrors);
});
