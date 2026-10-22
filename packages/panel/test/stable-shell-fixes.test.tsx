import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, Component, createElement, type ReactElement, type ReactNode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { titleFor } from '../src/components/layout/pageTitle';
import { CopyButton } from '../src/components/ui/CopyButton';
import { Toaster } from '../src/components/ui/Toaster';
import { resetFailedLazyImports, retryableLazy } from '../src/lib/retryableLazy';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();
const restorers: Array<() => void> = [];
const initialConnection = useConnectionStore.getState();

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
