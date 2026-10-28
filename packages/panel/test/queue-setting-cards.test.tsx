import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { QueuePolicyCard, QueueRunWindowCard } from '../src/pages/control/queue/QueueSettingCards';
import {
  button,
  byName,
  change,
  click,
  installStableFixHooks,
  render,
  settle,
} from './control-pages-stable-fixes.helpers';

installStableFixHooks();

const realFetch = globalThis.fetch;
interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];
let policy: unknown = null;
let runWindow: unknown = null;
let refuse: string | null = null;

const reply = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

function serve() {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: pathname, body });
    if (method !== 'GET' && refuse !== null) {
      return reply({ error: { code: 'unsupported_option', message: refuse } }, 400);
    }
    if (pathname === '/queues/orders/policy') {
      if (method === 'PUT') policy = Object.keys(body).length === 0 ? null : body;
      return reply({ ok: true, policy });
    }
    if (pathname === '/queues/orders/run-window') {
      if (method === 'PUT') {
        runWindow = {
          timezone: 'UTC',
          open: false,
          opensAt: 1_800_000_000_000,
          closesAt: 1_800_014_400_000,
          ...body,
        };
      }
      if (method === 'DELETE') runWindow = null;
      return reply({ ok: true, runWindow });
    }
    return reply({ ok: false }, 404);
  }) as typeof fetch;
}

const setRole = (role: 'operator' | 'viewer') =>
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: { ...DEMO_CAPABILITIES, principal: { role } },
    error: null,
    key: 'test',
  });

beforeEach(() => {
  calls = [];
  policy = null;
  runWindow = null;
  refuse = null;
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
  setRole('operator');
  serve();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const puts = () => calls.filter((call) => call.method === 'PUT');

describe('the Retry policy card', () => {
  test('says there is no policy, then saves one and shows it', async () => {
    const { host } = render(createElement(QueuePolicyCard, { queue: 'orders' }));
    await settle(30);
    expect(host.textContent).toContain('No policy');

    click(button(host, 'Edit'));
    change(byName(host, 'policy-attempts'), '5');
    change(byName(host, 'policy-backoff'), 'exponential');
    change(byName(host, 'policy-delay'), '1');
    change(byName(host, 'policy-timeout'), '30');
    click(button(host, 'Save'));
    await settle(30);

    expect(puts()).toEqual([
      {
        method: 'PUT',
        path: '/queues/orders/policy',
        body: { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, timeout: 30_000 },
      },
    ]);
    expect(host.textContent).toContain('5 attempts');
    expect(host.textContent).toContain('doubling each time up to 1 hour');
    expect(host.textContent).toContain('Saved ✓');
  });

  test('blank fields remove the policy', async () => {
    policy = { attempts: 3 };
    const { host } = render(createElement(QueuePolicyCard, { queue: 'orders' }));
    await settle(30);
    click(button(host, 'Edit'));
    change(byName(host, 'policy-attempts'), '');
    click(button(host, 'Save'));
    await settle(30);
    expect(puts()[0]?.body).toEqual({});
    expect(host.textContent).toContain('No policy');
  });

  test("shows the API's message when it refuses a value", async () => {
    refuse = 'attempts: must be at most 1000.';
    const { host } = render(createElement(QueuePolicyCard, { queue: 'orders' }));
    await settle(30);
    click(button(host, 'Edit'));
    change(byName(host, 'policy-attempts'), '5000');
    click(button(host, 'Save'));
    await settle(30);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('must be at most 1000');
    expect(host.textContent).toContain('No policy');
  });

  test('a viewer reads the policy and has nothing to edit', async () => {
    setRole('viewer');
    policy = { attempts: 3 };
    const { host } = render(createElement(QueuePolicyCard, { queue: 'orders' }));
    await settle(30);
    expect(host.textContent).toContain('3 attempts');
    expect(host.querySelector('button')).toBeNull();
  });
});

describe('the Run window card', () => {
  test('says there is no window, then saves one and shows when it opens', async () => {
    const { host } = render(createElement(QueueRunWindowCard, { queue: 'orders' }));
    await settle(30);
    expect(host.textContent).toContain('No window');

    click(button(host, 'Edit'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    change(byName(host, 'run-window-cron'), '0 0 * * *');
    change(byName(host, 'run-window-hours'), '4');
    change(byName(host, 'run-window-timezone'), 'Europe/London');
    click(button(host, 'Save'));
    await settle(30);

    expect(puts()).toEqual([
      {
        method: 'PUT',
        path: '/queues/orders/run-window',
        body: { cron: '0 0 * * *', durationMs: 14_400_000, timezone: 'Europe/London' },
      },
    ]);
    expect(host.textContent).toContain('4 hours');
    expect(host.textContent).toContain('○ Closed');
    expect(host.textContent).toContain('Saved ✓');
  });

  test("shows the API's message for a cron it cannot read", async () => {
    refuse = 'runWindow: cron "nope" is not a valid expression.';
    const { host } = render(createElement(QueueRunWindowCard, { queue: 'orders' }));
    await settle(30);
    click(button(host, 'Edit'));
    change(byName(host, 'run-window-cron'), 'nope');
    change(byName(host, 'run-window-hours'), '1');
    click(button(host, 'Save'));
    await settle(30);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'is not a valid expression'
    );
  });

  test('removing the window sends a DELETE after a yes', async () => {
    runWindow = {
      cron: '@daily',
      durationMs: 3_600_000,
      timezone: 'UTC',
      open: true,
      opensAt: 1,
      closesAt: 1_800_000_000_000,
    };
    const { host } = render(createElement(QueueRunWindowCard, { queue: 'orders' }));
    await settle(30);
    expect(host.textContent).toContain('● Open now');

    click(button(host, 'Edit'));
    click(button(host, 'Remove window'));
    await settle(10);
    const { useConfirmStore } = await import('../src/components/dashboard/stores/confirmStore');
    useConfirmStore.getState().current?.resolve(true);
    await settle(30);

    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(host.textContent).toContain('No window');
  });

  test('a viewer reads the window and has nothing to edit', async () => {
    setRole('viewer');
    runWindow = {
      cron: '@daily',
      durationMs: 3_600_000,
      timezone: 'UTC',
      open: false,
      opensAt: 1_800_000_000_000,
      closesAt: 1_800_003_600_000,
    };
    const { host } = render(createElement(QueueRunWindowCard, { queue: 'orders' }));
    await settle(30);
    expect(host.textContent).toContain('@daily');
    expect(host.querySelector('button')).toBeNull();
  });
});
