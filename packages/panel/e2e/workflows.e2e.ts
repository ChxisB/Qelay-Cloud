import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  E2E_APP_URL,
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

const controlHeaders = { Authorization: `Bearer ${E2E_CONTROL_TOKEN}` };

// The workflow worker shows in the worker registry; the specs that expect none must not see it.
test.afterAll(async () => {
  await fetch(`${E2E_CONTROL_URL}/workflow/stop`, { method: 'POST', headers: controlHeaders });
});

async function startRun(request: APIRequestContext, name: string, input: unknown): Promise<string> {
  const response = await request.post(`${E2E_CONTROL_URL}/workflow/start`, {
    headers: controlHeaders,
    data: { name, input },
  });
  expect(response.ok(), `workflow/start failed: ${await response.text()}`).toBe(true);
  return (await response.json()).id;
}

const execution = (page: Page, id: string): Locator =>
  page.locator('#main').getByRole('region', { name: `Execution ${id}`, exact: true });
const actions = (page: Page): Locator =>
  page.locator('#main').getByRole('region', { name: 'Execution actions' });
const tab = (page: Page, name: string): Locator =>
  page.locator('#main nav[aria-label="Execution detail"]').getByRole('button', { name });

async function openRun(page: Page, id: string, tabName = '', mount: Mount = OPERATOR) {
  const query = tabName ? `&tab=${tabName}` : '';
  await goInApp(page, `/workflows?execution=${encodeURIComponent(id)}${query}`, mount);
  await expect(execution(page, id)).toBeVisible();
}

/** The detail page reads again every few seconds; waiting for a state is waiting for that. */
const expectState = (page: Page, id: string, state: string) =>
  expect(execution(page, id).locator('header')).toContainText(state, { timeout: 30_000 });

async function auditOf(request: APIRequestContext, id: string) {
  const audit = await request.get(`${E2E_APP_URL}/api/audit?limit=100`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(audit.ok()).toBe(true);
  return ((await audit.json()).entries as Array<Record<string, unknown>>).filter(
    (entry) =>
      entry.action === 'POST /workflows/executions/:id/actions' &&
      String(entry.target).includes(`id=${id} `)
  );
}

test('workflow: an operator finds a waiting run, sends the signal it awaits, and the run completes', async ({
  page,
  request,
  browserErrors,
}) => {
  test.setTimeout(90_000);
  const id = await startRun(request, 'e2e-approval', { order: 'A-1' });
  await unlockDashboard(page);

  // One sidebar item, "Flows", and a switch on the page between job flows and workflow runs.
  await clickNavLink(page, page.locator(`#app-nav nav a[href="${OPERATOR.basePath}/flows"]`));
  await page
    .getByRole('navigation', { name: 'Kind of flow' })
    .getByRole('link', { name: 'Workflow runs' })
    .click();
  await expect(page).toHaveURL(`${OPERATOR.appUrl}/workflows`);
  await expect(
    page.locator('#main').getByRole('heading', { name: 'Flows', level: 1 })
  ).toBeVisible();
  // The workers announced their definitions, so the page lists them as served.
  await expect(page.locator('#main').getByText('e2e-approval').first()).toBeVisible();
  const listed = page.locator('#main tbody tr', { hasText: id });
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(listed).toContainText('Waiting for approved', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await listed.getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp(`/workflows\\?execution=${encodeURIComponent(id)}`));
  await expectState(page, id, 'waiting');
  await actions(page).getByRole('button', { name: 'Send signal' }).click();
  const form = page.getByRole('form', { name: 'Send a signal' });
  await expect(form.locator('input[name="signal-event"]')).toHaveValue('approved');
  await form.getByRole('button', { name: 'Send signal' }).click();
  await expect(actions(page).getByRole('status')).toContainText('put back on its queue');
  await expectState(page, id, 'completed');

  await tab(page, 'Steps').click();
  const steps = execution(page, id).getByRole('list', { name: /^Steps/ });
  await expect(steps).toContainText('prepare');
  await expect(steps).toContainText('finish');
  await tab(page, 'Payloads').click();
  await expect(execution(page, id)).toContainText('Signals (1)');

  // The mutation left one audit row that names the action and carries no payload.
  const rows = await auditOf(request, id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome: 'success', status: 200 });
  expect(String(rows[0]?.target)).toContain('workflowAction=signal');
  expect(JSON.stringify(rows[0])).not.toContain('A-1');
  expectNoBrowserErrors(browserErrors);
});

test('workflow: cancelling needs the run id typed back, and what the run did is rolled back', async ({
  page,
  request,
  browserErrors,
}) => {
  test.setTimeout(90_000);
  const id = await startRun(request, 'e2e-approval', { order: 'B-2' });
  await unlockDashboard(page);
  await openRun(page, id);
  await expectState(page, id, 'waiting');

  await actions(page).getByRole('button', { name: 'Cancel run' }).click();
  const confirm = page.getByRole('form', { name: 'Confirm: Cancel run' });
  const submit = confirm.getByRole('button', { name: 'Cancel run' });
  await expect(submit).toBeDisabled();
  await confirm.getByLabel('Type the execution id to confirm').fill(id.slice(0, -1));
  await expect(submit).toBeDisabled();
  await confirm.getByLabel('Type the execution id to confirm').fill(id);
  await submit.click();
  await expect(actions(page).getByRole('status')).toContainText('The run was cancelled');

  await expectState(page, id, 'failed');
  await expect(execution(page, id).getByRole('region', { name: 'Rollback' })).toContainText(
    'The rollback finished.',
    { timeout: 30_000 }
  );
  await expect(actions(page)).toContainText('Nothing can be done to this run');
  const rows = await auditOf(request, id);
  expect(rows).toHaveLength(1);
  expect(String(rows[0]?.target)).toContain('workflowAction=cancel');
  expectNoBrowserErrors(browserErrors);
});

test('workflow: a step that fails is shown with its rollback', async ({
  page,
  request,
  browserErrors,
}) => {
  test.setTimeout(90_000);
  const id = await startRun(request, 'e2e-checkout', {});
  await unlockDashboard(page);
  await openRun(page, id, 'steps');
  await expectState(page, id, 'failed');

  const steps = execution(page, id).getByRole('list', { name: /^Steps/ });
  await expect(steps).toContainText('ship');
  await expect(steps).toContainText('carrier rejected the parcel');
  // Both steps that had been done were undone, newest first.
  await expect(steps.getByText('Rollback')).toHaveCount(2, { timeout: 30_000 });
  expectNoBrowserErrors(browserErrors);
});

test('workflow: a rollback that cannot finish is retried once its cause is fixed', async ({
  page,
  request,
  browserErrors,
}) => {
  test.setTimeout(120_000);
  const id = await startRun(request, 'e2e-checkout', { refundDown: true });
  await unlockDashboard(page);
  await openRun(page, id);
  await expectState(page, id, 'compensation-stuck');
  const rollback = execution(page, id).getByRole('region', { name: 'Rollback' });
  await expect(rollback).toContainText('The rollback stopped at a step it could not undo.');
  await expect(
    rollback.getByRole('list', { name: 'Steps that could not be undone' })
  ).toContainText('refund service unavailable');
  await expect(actions(page).getByRole('button')).toHaveText([
    'Retry rollback',
    'Abandon rollback…',
  ]);
  // The definition shows where it stopped, and the way back.
  await tab(page, 'Definition').click();
  await expect(execution(page, id).getByRole('note')).toContainText('The rollback is stuck');
  await expect(
    execution(page, id)
      .getByRole('list', { name: 'Nodes of the workflow' })
      .locator('[aria-current="step"]')
  ).toHaveCount(1);
  await tab(page, 'Summary').click();

  const repaired = await request.post(`${E2E_CONTROL_URL}/workflow/repair`, {
    headers: controlHeaders,
    data: { id },
  });
  expect(repaired.ok()).toBe(true);
  await actions(page).getByRole('button', { name: 'Retry rollback' }).click();
  await expect(actions(page).getByRole('status')).toContainText('put back on its queue');
  await expectState(page, id, 'failed');
  await expect(rollback).toContainText('The rollback finished.', { timeout: 30_000 });
  const rows = await auditOf(request, id);
  expect(rows.map((row) => String(row.target).split(' ').pop())).toEqual([
    'workflowAction=retry-compensation',
  ]);
  expectNoBrowserErrors(browserErrors);
});

test('workflow: a viewer reads a run and changes nothing, a stale version is refused, and nothing moves', async ({
  page,
  request,
  browserErrors,
}) => {
  const id = await startRun(request, 'e2e-approval', { order: 'C-3' });
  await unlockDashboard(page, false, VIEWER);
  await openRun(page, id, '', VIEWER);
  await expectState(page, id, 'waiting');
  await expect(actions(page)).toContainText(
    'Your role can look at workflow executions but not change them.'
  );
  await expect(actions(page).getByRole('button')).toHaveCount(0);

  const url = `/api/workflows/executions/${encodeURIComponent(id)}`;
  const forced = await request.post(`${E2E_VIEWER_URL}${url}/actions`, {
    headers: { Authorization: `Bearer ${E2E_VIEWER_TOKEN}` },
    data: { action: 'cancel', expectedVersion: 1, confirm: id },
  });
  expect(forced.status()).toBe(403);
  expect((await forced.json()).error.code).toBe('forbidden');

  // An operator who read an older picture is refused by the version, and the run is as it was.
  const read = async () =>
    (
      await (
        await request.get(`${E2E_APP_URL}${url}`, {
          headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
        })
      ).json()
    ).execution;
  const before = await read();
  const stale = await request.post(`${E2E_APP_URL}${url}/actions`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: { action: 'signal', event: 'approved', expectedVersion: before.version - 1 },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toMatchObject({
    code: 'version_conflict',
    details: { actualVersion: before.version },
  });
  const after = await read();
  expect(after).toMatchObject({ state: 'waiting', version: before.version });
  expectNoBrowserErrors(browserErrors);
});

test('workflow: a for-each over ten thousand items shows counts, and its iterations a page at a time', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const id = `e2e-fanout-${testInfo.project.name}-${testInfo.retry}`;
  const seeded = await request.post(`${E2E_CONTROL_URL}/seed/fanout`, {
    headers: controlHeaders,
    data: { id, iterations: 10_000 },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await unlockDashboard(page);
  await openRun(page, id, 'steps');

  const counts = execution(page, id).getByLabel('Iterations of notify', { exact: true });
  await expect(counts).toContainText('10.000');
  await expect(counts).toContainText('Failed100');
  // One entry for the loop, not ten thousand rows.
  expect(await execution(page, id).locator('ol > li').count()).toBeLessThan(10);

  await execution(page, id)
    .getByRole('button', { name: /Show iterations/ })
    .click();
  const page1 = execution(page, id).getByRole('list', { name: 'Iterations of notify, page 1' });
  await expect(page1.locator('li')).toHaveCount(25);
  await expect(execution(page, id)).toContainText('1–25 of 10.000 iterations');
  await execution(page, id).getByRole('button', { name: 'Next' }).click();
  await expect(execution(page, id)).toContainText('26–50 of 10.000 iterations');

  await execution(page, id).getByRole('button', { name: 'failed', exact: true }).click();
  const failed = execution(page, id).getByRole('list', { name: 'Iterations of notify, page 1' });
  await expect(failed).toContainText('no stock for sku-7');
  await expect(execution(page, id)).toContainText('1–25 of 100 iterations');
  expectNoBrowserErrors(browserErrors);
});
