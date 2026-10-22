import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { RouteGate } from '../src/components/RouteGate';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES, FAIL_CLOSED } from '../src/lib/capabilities/types';
import { ensureDom } from './domSetup';

ensureDom();

const CLOUD: Capabilities = {
  ...DEMO_CAPABILITIES,
  hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet'],
  features: { dlq: true, cron: true, flows: false, workflows: false, webhooks: false },
};

const mounted: Array<() => void> = [];
let retried = 0;

function at(path: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          RouteGate,
          { onRetry: () => (retried += 1) },
          createElement('p', { 'data-testid': 'page' }, 'the page')
        )
      )
    )
  );
  return host;
}

const serve = (
  caps: Capabilities,
  status: 'ready' | 'loading' | 'error',
  error: string | null = null
) => useCapabilitiesStore.setState({ status, caps, error, key: 'test' });

beforeEach(() => {
  retried = 0;
});
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  serve(DEMO_CAPABILITIES, 'ready');
});

describe('RouteGate', () => {
  test('a hidden page, reached by its URL, says it is not available here', () => {
    serve(CLOUD, 'ready');
    const host = at('/server');
    expect(host.textContent).toContain('Not available in this deployment');
    expect(host.textContent).toContain('Server control');
    expect(host.querySelector('[data-testid="page"]')).toBeNull();
  });

  test('a feature that is off is the same', () => {
    serve(CLOUD, 'ready');
    const host = at('/workflows');
    expect(host.textContent).toContain('Not available in this deployment');
  });

  test('a page the deployment serves renders', () => {
    serve(CLOUD, 'ready');
    expect(at('/dlq').querySelector('[data-testid="page"]')).not.toBeNull();
    expect(at('/queues').querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('a closable page waits for the answer instead of flashing', () => {
    serve(FAIL_CLOSED, 'loading');
    const host = at('/dlq');
    expect(host.querySelector('[data-testid="page"]')).toBeNull();
    expect(host.textContent).toContain('Checking what this deployment offers');
  });

  test('an always-there page is not held up by the answer', () => {
    serve(FAIL_CLOSED, 'loading');
    expect(at('/queues').querySelector('[data-testid="page"]')).not.toBeNull();
    expect(at('/settings').querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('a failed load says so, stays closed, and offers a retry', () => {
    serve(FAIL_CLOSED, 'error', 'HTTP 502');
    const host = at('/dlq');
    expect(host.querySelector('[data-testid="page"]')).toBeNull();
    expect(host.textContent).toContain('HTTP 502');
    expect(host.querySelector('h1')?.textContent).toBe('This page could not be opened');
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Retry');
    act(() => button?.click());
    expect(retried).toBe(1);
  });
});
