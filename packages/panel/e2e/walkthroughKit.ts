/**
 * What the walkthrough specs share: moving about the panel without a reload, calling the operator's
 * Control API from the test, and adding a job through the Add Job form.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_APP_URL, E2E_SERVER_TOKEN } from './config';
import { expect, OPERATOR } from './fixtures';

const operator = { Authorization: `Bearer ${E2E_SERVER_TOKEN}` };

/** Moves inside the app without a reload: a reload would drop the in-memory credential. */
export async function go(page: Page, route: string, mount = OPERATOR): Promise<void> {
  await page.evaluate(
    ({ basePath, path }) => {
      window.history.pushState({}, '', `${basePath}${path}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    { basePath: mount.basePath, path: route }
  );
  await expect(page).toHaveURL(`${mount.appUrl}${route}`);
}

export async function read(request: APIRequestContext, path: string) {
  const response = await request.get(`${E2E_APP_URL}/api${path}`, { headers: operator });
  return { status: response.status(), body: await response.json() };
}

export async function post(
  request: APIRequestContext,
  path: string,
  data: unknown,
  method = 'POST'
) {
  const response = await request.fetch(`${E2E_APP_URL}/api${path}`, {
    method,
    headers: operator,
    data,
  });
  return { status: response.status(), body: await response.json() };
}

/** Fills the Add Job form and returns the id the server accepted. */
export async function addThroughForm(
  page: Page,
  queue: string,
  name: string,
  data: object,
  options: Record<string, string> = {}
): Promise<string> {
  await go(page, '/add-job');
  await expect(page.getByRole('heading', { name: 'Add job', level: 1 })).toBeVisible();
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Job name', { exact: true }).fill(name);
  await page.getByLabel('Data (JSON)').fill(JSON.stringify(data));
  for (const [label, value] of Object.entries(options)) {
    const field = page.getByLabel(label, { exact: true });
    // Some options sit behind "More options"; a closed <details> cannot be filled.
    if (!(await field.isVisible()))
      await page.locator('summary', { hasText: 'More options' }).click();
    await field.fill(value);
  }
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add job', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  return String((await response.json()).id);
}

export const stateOf = (request: APIRequestContext, id: string) => async () =>
  (await read(request, `/jobs/${id}`)).body.job?.state;
