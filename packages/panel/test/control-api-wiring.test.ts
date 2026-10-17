import {
  BqError,
  bq,
  describe,
  expect,
  fetchHarness,
  headerOf,
  installTestHooks,
  json,
  lastCall,
  test,
} from './bq.helpers';

installTestHooks();

const bodyOf = (init?: RequestInit): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

describe('Control API error bodies', () => {
  test('{ error: { code, message } } surfaces its message and code, not "[object Object]"', async () => {
    fetchHarness.responder = () =>
      json(
        {
          error: {
            code: 'job_state',
            message: 'the job is completed, so the action does not apply',
          },
        },
        409
      );
    const err = (await bq.promoteJob('j1').catch((e: unknown) => e)) as BqError;
    expect(err).toBeInstanceOf(BqError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('job_state');
    expect(err.message).toBe('The job is completed, so the action does not apply.');
  });

  test('403 names the missing permission', async () => {
    fetchHarness.responder = () =>
      json({ error: { code: 'forbidden', message: 'this action needs the operator role' } }, 403);
    const err = (await bq.pause('orders').catch((e: unknown) => e)) as BqError;
    expect(err.status).toBe(403);
    expect(err.message).toContain('You do not have permission');
    expect(err.message).toContain('operator role');
  });

  test('409 version_conflict keeps the versions in details', async () => {
    fetchHarness.responder = () =>
      json(
        {
          error: {
            code: 'version_conflict',
            message: 'the job changed since it was read, so nothing was changed',
            details: { jobId: 'j1', expectedVersion: 1, actualVersion: 3 },
          },
        },
        409
      );
    const err = (await bq.promoteJob('j1', 1).catch((e: unknown) => e)) as BqError;
    expect(err.code).toBe('version_conflict');
    expect(err.details).toEqual({ jobId: 'j1', expectedVersion: 1, actualVersion: 3 });
    expect(err.message).toContain('Reload it and try again');
  });

  test('501 is a neutral "not available", with its status for the caller to branch on', async () => {
    fetchHarness.responder = () =>
      json(
        { error: { code: 'not_supported', message: 'failing a job is not available here' } },
        501
      );
    const err = (await bq.failJob('j1', 'x').catch((e: unknown) => e)) as BqError;
    expect(err.status).toBe(501);
    expect(err.message).toStartWith('Not available in this deployment.');
  });

  test('401 raises auth:required with the target, and the message is still text', async () => {
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      fetchHarness.responder = () =>
        json({ error: { code: 'unauthorized', message: 'a valid bearer token is required' } }, 401);
      const seen: unknown[] = [];
      target.addEventListener('auth:required', (event) => {
        seen.push((event as CustomEvent).detail);
      });
      const err = (await bq.overview().catch((e: unknown) => e)) as BqError;
      expect(err.message).toBe('A valid bearer token is required.');
      expect(err.code).toBe('unauthorized');
      expect(seen).toEqual([{ scope: 'server', auth: undefined, target: 'http://srv' }]);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    }
  });
});

describe('what a destructive queue action sends', () => {
  test.each([
    ['drain', () => bq.drain('orders'), '/queues/orders/drain', { confirm: 'orders' }],
    [
      'obliterate',
      () => bq.obliterate('orders'),
      '/queues/orders/obliterate',
      { confirm: 'orders' },
    ],
    [
      'clean',
      () => bq.clean('orders', { grace: 5, state: 'completed' }),
      '/queues/orders/clean',
      { grace: 5, state: 'completed', confirm: 'orders' },
    ],
    ['purge DLQ', () => bq.purgeDlq('orders'), '/queues/orders/dlq/purge', { confirm: 'orders' }],
  ])('%s carries the queue name as confirm', async (_name, run, path, expected) => {
    await run();
    expect(lastCall().url).toBe(`http://srv${path}`);
    expect(bodyOf(lastCall().init)).toEqual(expected);
  });

  test('the confirmation is the queue name as typed, not its path form', async () => {
    await bq.drain('billing.eu:daily');
    expect(lastCall().url).toBe('http://srv/queues/billing.eu%3Adaily/drain');
    expect(bodyOf(lastCall().init)).toEqual({ confirm: 'billing.eu:daily' });
  });
});

describe('what a job action sends when the version is known', () => {
  test('promote fences with expectedVersion in the body', async () => {
    await bq.promoteJob('j1', 4);
    expect(bodyOf(lastCall().init)).toEqual({ expectedVersion: 4 });
  });

  test('promote without a version sends no body at all', async () => {
    await bq.promoteJob('j1');
    expect(lastCall().init?.body).toBeUndefined();
  });

  test('cancel fences with the query string', async () => {
    await bq.cancelJob('j1', 0);
    expect(lastCall().url).toBe('http://srv/jobs/j1?expectedVersion=0');
    expect(lastCall().init?.method).toBe('DELETE');
  });

  test('data, priority and delay carry the fence beside their own fields', async () => {
    await bq.updateJobData('j1', { a: 1 }, 2);
    expect(bodyOf(lastCall().init)).toEqual({ data: { a: 1 }, expectedVersion: 2 });
    await bq.changePriority('j1', 7, undefined, 2);
    expect(bodyOf(lastCall().init)).toEqual({ priority: 7, expectedVersion: 2 });
    await bq.changeDelay('j1', 500, 2);
    expect(bodyOf(lastCall().init)).toEqual({ delay: 500, expectedVersion: 2 });
  });

  test('the same actions without a version send exactly what they sent before', async () => {
    await bq.updateJobData('j1', 'x');
    expect(bodyOf(lastCall().init)).toEqual({ data: 'x' });
    await bq.changeDelay('j1', 500);
    expect(bodyOf(lastCall().init)).toEqual({ delay: 500 });
    expect(headerOf(lastCall().init, 'Content-Type')).toBe('application/json');
  });
});
