import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, Component, createElement, type ReactElement, type ReactNode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { titleFor } from '../src/components/layout/pageTitle';
import { CopyButton } from '../src/components/ui/CopyButton';
import { Toaster } from '../src/components/ui/Toaster';
import { resetFailedLazyImports, retryableLazy } from '../src/lib/retryableLazy';
import { QueueDetail } from '../src/pages/QueueDetail';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();
const restorers: Array<() => void> = [];
const initialConnection = useConnectionStore.getState();

const json = (value: unknown) =>
  Response.json(value, { headers: { 'content-type': 'application/json' } });

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, root, unmount };
}

class Boundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      resetFailedLazyImports();
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed ? createElement('p', null, 'failed') : this.props.children;
  }
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  for (const restore of restorers.splice(0)) restore();
  globalThis.fetch = realFetch;
  useConnectionStore.setState(initialConnection, true);
});

describe('retryableLazy', () => {
  test('issues a fresh import after a failed chunk once the boundary resets', async () => {
    let online = false;
    let calls = 0;
    const Page = retryableLazy(async () => {
      calls += 1;
      if (!online) throw new Error('chunk failed');
      return { default: () => createElement('p', null, 'loaded') };
    });
    const tree = (key: string) =>
      createElement(
        Boundary,
        { resetKey: key },
        createElement(
          Suspense,
          { fallback: createElement('p', null, 'loading') },
          createElement(Page)
        )
      );
    const realError = console.error;
    console.error = () => {};
    try {
      const { host, root } = render(tree('a'));
      await settle(5);
      expect(host.textContent).toBe('failed');
      const failedCalls = calls;
      // The cached failure is not refetched in a render loop while offline.
      await settle(5);
      expect(calls).toBe(failedCalls);

      // A plain React.lazy would re-throw its cached rejection here forever.
      online = true;
      act(() => root.render(tree('b')));
      await settle(5);
      expect(host.textContent).toBe('loaded');
      expect(calls).toBe(failedCalls + 1);
    } finally {
      console.error = realError;
    }
  });
});

describe('page titles', () => {
  test('resolve case-insensitively like React Router while keeping queue-name case', () => {
    expect(titleFor('/Settings')).toBe('Settings');
    expect(titleFor('/QUEUES')).toBe('Queues');
    expect(titleFor('/Queues/Email')).toBe('Email · Queue');
    expect(titleFor('/QUEUES-CLASSIC/Email')).toBe('Email · Queue (classic)');
  });
});

describe('toast live region', () => {
  test('stays mounted while empty so the first toast is announced', () => {
    useToastStore.setState({ toasts: [] });
    const { host } = render(createElement(Toaster));
    const region = host.querySelector('section[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.children.length).toBe(0);
  });
});

describe('CopyButton fallback copy', () => {
  test('restores keyboard focus after the hidden-textarea copy path', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const execCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true });
    restorers.push(() => {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (execCommand) Object.defineProperty(document, 'execCommand', execCommand);
      else Reflect.deleteProperty(document, 'execCommand');
    });
    const { host } = render(createElement(CopyButton, { value: 'job-1' }));
    const button = host.querySelector('button');
    button?.focus();
    expect(document.activeElement).toBe(button);

    act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(1);
    expect(button?.getAttribute('aria-label')).toBe('Copied to clipboard');
    expect(document.activeElement).toBe(button);
  });
});

describe('classic queue detail job names', () => {
  test('prefer the first-class job name and never render object-valued data names', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        return json([
          {
            name: 'orders',
            paused: false,
            counts: { waiting: 2, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
          },
        ]);
      }
      if (url.includes('/dashboard/queues/orders?includeJobs=false')) {
        return json({
          ok: true,
          name: 'orders',
          counts: {
            waiting: 2,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
            prioritized: 0,
            'waiting-children': 0,
            paused: 0,
          },
          paused: false,
          priorityCounts: {},
          dlqPreview: [],
          timestamp: 1,
        });
      }
      if (url.includes('/queues/orders/jobs/list?')) {
        return json({
          ok: true,
          jobs: [
            { id: 'j1', name: 'send-email', state: 'waiting', data: { name: 'Alice' } },
            { id: 'j2', state: 'waiting', data: { name: { first: 'Ada' } } },
          ],
        });
      }
      return json({ ok: false, error: `unexpected ${url}` });
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/queues-classic/orders'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/queues-classic/:name',
            element: createElement(QueueDetail),
          })
        )
      )
    );
    await settle(10);
    const rows = [...host.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
    expect(rows.some((row) => row.includes('j1') && row.includes('send-email'))).toBe(true);
    expect(rows.some((row) => row.includes('Alice'))).toBe(false);
    expect(rows.some((row) => row.includes('j2') && row.includes('default'))).toBe(true);
    expect(host.textContent).not.toContain('Something went wrong');
  });
});
