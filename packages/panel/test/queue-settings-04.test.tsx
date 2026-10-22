import { UnavailableNote } from '../src/pages/control/queue/UnavailableNote';
import {
  bq,
  click,
  concurrencyArgs,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  LifecycleCard,
  promoteConfirmation,
  type RunAction,
  rateLimitArgs,
  render,
  test,
} from './queue-settings.helpers';

installTestHooks();

describe('Queue lifecycle request scope and destructive confirmations', () => {
  test('flow-destructive queue operations are not offered, and the reason is stated once', () => {
    let calls = 0;
    const run: RunAction = () => {
      calls += 1;
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );
    const labels = Array.from(host.querySelectorAll('button')).map((button) => button.textContent);
    for (const gone of ['Clean', 'Drain', 'Requeue completed']) expect(labels).not.toContain(gone);
    expect(host.querySelector('[name="clean-state"]')).toBeNull();
    expect(calls).toBe(0);

    const note = render(createElement(UnavailableNote)).host.textContent ?? '';
    expect(note).toContain('Not available on this server');
    expect(note).toContain('Drain, Clean and Obliterate');
    expect(note).toContain('reverse flow dependencies');
    expect(note).toContain('Completed-job requeue is unavailable');
  });

  test('promotion still names its full effect and target', () => {
    let confirmation: Parameters<RunAction>[2];
    let calls = 0;
    const run: RunAction = (_label, _fn, nextConfirmation) => {
      calls += 1;
      confirmation = nextConfirmation;
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );

    click(host, 'Run delayed jobs');
    expect(calls).toBe(1);
    expect(confirmation?.question).toContain('every delayed job');
    expect(confirmation?.confirmLabel).toBe('Run delayed jobs');
    expect(promoteConfirmation('orders', 3)).toContain('up to 3 delayed jobs');
  });

  test('rate-limit and concurrency controls send exact v2.8.55 bodies and methods', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ ok: true });
    }) as typeof fetch;

    const rate = rateLimitArgs('10', '60000', '3600000');
    const concurrency = concurrencyArgs('4');
    expect(rate.valid).toBe(true);
    expect(concurrency.valid).toBe(true);
    await bq.setRateLimit('orders', rate.limit, rate.duration, rate.ttl);
    await bq.setConcurrency('orders', concurrency.value);
    await bq.clearRateLimit('orders');
    await bq.clearConcurrency('orders');

    expect(calls).toEqual([
      {
        path: '/queues/orders/rate-limit',
        method: 'PUT',
        body: { limit: 10, duration: 60_000, ttl: 3_600_000 },
      },
      {
        path: '/queues/orders/concurrency',
        method: 'PUT',
        body: { concurrency: 4 },
      },
      { path: '/queues/orders/rate-limit', method: 'DELETE', body: undefined },
      { path: '/queues/orders/concurrency', method: 'DELETE', body: undefined },
    ]);
  });

  test('zero, negative, fractional and unsafe integers are refused before any PUT is built', () => {
    const invalid = ['0', '-1', '0.5', String(Number.MAX_SAFE_INTEGER + 1), ''];
    for (const value of invalid) {
      expect(concurrencyArgs(value).valid, `concurrency ${value}`).toBe(false);
      expect(rateLimitArgs(value, '60000', '').valid, `rate limit ${value}`).toBe(false);
      expect(rateLimitArgs('10', value, '').valid, `rate duration ${value}`).toBe(false);
    }
    for (const value of invalid.slice(0, -1)) {
      expect(rateLimitArgs('10', '60000', value).valid, `rate ttl ${value}`).toBe(false);
    }
  });
});
