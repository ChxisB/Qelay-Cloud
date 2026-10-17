/**
 * The operator walkthrough of the Phase 2 gate (task 37): one operator, the real panel, the real
 * Control API, a real worker and the real tick, from adding a job to reading the tick's age.
 *
 * Two things the panel does not offer are exercised at the API and said so where they come up:
 * purging a dead-letter queue (the panel's Purge buttons stay disabled by its flow-safety rule
 * while the API supports it, with a confirmation) and editing a cron (the form refuses a name that
 * exists, so a replace is an upsert).
 */
import { E2E_WORKER_NAME } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';
import { addThroughForm, go, post, read, stateOf } from './walkthroughKit';

test.beforeEach(async ({ request }) => {
  await control(request, '/upstream/start');
  await control(request, '/tick/start');
});

test.afterEach(async ({ request }) => {
  await control(request, '/worker/stop');
});

test('an operator runs a queue from the first job to the tick, and the panel agrees at each step', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  test.setTimeout(120_000);
  const queue = `walk-${testInfo.project.name}-${testInfo.retry}`;
  const cron = `walk-cron-${testInfo.project.name}-${testInfo.retry}`;
  await control(request, '/worker/start', { queue });
  await unlockDashboard(page);

  const completed = await test.step('add a job; the worker completes it', async () => {
    const id = await addThroughForm(page, queue, 'plain', { n: 1 });
    await expect.poll(stateOf(request, id)).toBe('completed');
    return id;
  });

  await test.step('add a delayed job; it waits, then runs', async () => {
    const id = await addThroughForm(page, queue, 'later', { n: 2 }, { 'Delay (ms)': '2500' });
    expect(await stateOf(request, id)()).toBe('delayed');
    await expect.poll(stateOf(request, id), { timeout: 20_000 }).toBe('completed');
  });

  await test.step('watch a job go by on the live Activity Logs', async () => {
    await go(page, '/logs');
    await expect(page.getByRole('heading', { name: 'Activity Logs', level: 1 })).toBeVisible();
    const added = await post(request, `/queues/${queue}/jobs`, { name: 'watched', data: {} });
    const row = page.locator('#main tbody tr').filter({ hasText: String(added.body.id) });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });
  });

  await test.step('pause the queue: a new job waits; resume: it runs', async () => {
    await go(page, '/queue-control');
    await page.getByRole('combobox', { name: 'Queue', exact: true }).selectOption(queue);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    const added = await post(request, `/queues/${queue}/jobs`, { name: 'held', data: {} });
    const id = String(added.body.id);
    await page.waitForTimeout(2_000);
    expect(await stateOf(request, id)()).toBe('waiting');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(stateOf(request, id)).toBe('completed');
  });

  const failed =
    await test.step('a failing job exhausts its attempts and lands in the DLQ', async () => {
      const id = await addThroughForm(
        page,
        queue,
        'doomed',
        { fail: true },
        { 'Max attempts': '2', 'Backoff (ms)': '100' }
      );
      await expect.poll(stateOf(request, id), { timeout: 20_000 }).toBe('failed');
      await go(page, `/dlq?queue=${queue}`);
      await expect(
        page.getByRole('heading', { name: 'Dead Letter Queue', level: 1 })
      ).toBeVisible();
      const entry = page.getByRole('row').filter({ hasText: id });
      await expect(entry).toContainText('max_attempts_exceeded');
      await expect(entry).toContainText('walkthrough failure');
      return id;
    });

  await test.step('the inspector shows the error and both attempts', async () => {
    const job = (await read(request, `/jobs/${failed}`)).body.job;
    expect(job.attempts).toBe(2);
    expect(job.failedReason).toContain('walkthrough failure');
    await go(page, '/job');
    await page.getByLabel('Job ID', { exact: true }).fill(failed);
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await expect(page.locator('#main').getByText('walkthrough failure').first()).toBeVisible();
  });

  await test.step('purge: refused without the queue name, done with it (at the API)', async () => {
    const purge = `/queues/${queue}/dlq/purge`;
    const bare = await post(request, purge, {});
    expect([bare.status, bare.body.error.code]).toEqual([400, 'confirmation_required']);
    const wrong = await post(request, purge, { confirm: 'not-the-queue' });
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'confirmation_required']);
    expect((await read(request, `/queues/${queue}/dlq/stats`)).body.stats.total).toBe(1);
    const done = await post(request, purge, { confirm: queue });
    expect([done.status, done.body.count, done.body.done]).toEqual([200, 1, true]);
    expect((await read(request, `/jobs/${failed}`)).status).toBe(404);
    await go(page, `/dlq?queue=${queue}`);
    await expect(page.getByText('No dead letter entries', { exact: true })).toBeVisible();
  });

  await test.step('create a cron in the form, replace it, and delete it', async () => {
    // The form asks the operator to confirm an upsert, and a removal, in the browser's own dialog.
    page.on('dialog', (dialog) => void dialog.accept());
    await go(page, '/cron');
    await expect(page.getByRole('heading', { name: 'Cron Manager', level: 1 })).toBeVisible();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(cron);
    await page.getByRole('textbox', { name: 'Queue', exact: true }).fill(`${queue}-cron`);
    await page.getByRole('button', { name: 'every', exact: true }).click();
    await page.getByLabel('Every (ms)').fill('1000');
    await page.getByRole('button', { name: 'Submit upsert' }).click();
    const row = page.getByRole('row').filter({ hasText: cron });
    await expect(row).toBeVisible();
    // The tick fires it: the cron's executions count rises and its jobs appear on its queue.
    await expect
      .poll(async () => (await read(request, `/crons/${cron}`)).body.cron.executions, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const counts = (await read(request, `/queues/${queue}-cron/counts`)).body.counts;
    expect(counts.waiting).toBeGreaterThan(0);

    // The form refuses an existing name; a replace is an upsert, and it changes the timing.
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(cron);
    await expect(page.getByRole('button', { name: 'Name already exists' })).toBeDisabled();
    const replaced = await post(
      request,
      `/crons/${cron}`,
      { name: cron, queue: `${queue}-cron`, repeatEvery: 3_600_000 },
      'PUT'
    );
    expect(replaced.status).toBe(200);
    expect((await read(request, `/crons/${cron}`)).body.cron.repeatEvery).toBe(3_600_000);

    await page.getByRole('button', { name: `Delete cron ${cron}` }).click();
    await expect.poll(async () => (await read(request, `/crons/${cron}`)).status).toBe(404);
  });

  await test.step('the Workers page lists the running worker', async () => {
    await go(page, '/workers');
    await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
    await expect(page.locator('#main').getByText(E2E_WORKER_NAME).first()).toBeVisible();
    const workers = (await read(request, '/workers')).body.data.workers as Array<{ id: string }>;
    expect(workers.length).toBeGreaterThan(0);
  });

  await test.step('Transport and Deployment: the queue is there and the tick is young', async () => {
    await go(page, '/transport');
    const table = page.getByRole('table', { name: 'Doorbell health per queue' });
    await expect(table.getByRole('row', { name: new RegExp(`^${queue} `, 'u') })).toBeVisible();
    await go(page, '/deployment');
    await expect(page.getByRole('heading', { name: 'Tick' })).toBeVisible();
    await expect(page.locator('#main')).toContainText(/Last success[\s\S]*\(\d+s ago\)/u);
    const tick = (await read(request, '/deployment')).body.tick;
    expect(tick.state).toBe('ok');
    expect(Date.now() - tick.lastSuccessAt).toBeLessThan(10_000);
  });

  expect(await stateOf(request, completed)()).toBe('completed');
  expectNoBrowserErrors(browserErrors);
});
