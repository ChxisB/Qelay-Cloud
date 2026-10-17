import { afterEach, beforeEach } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ensureDom } from './domSetup';

export { settle } from './domSetup';

// Shared DOM helpers for the control-pages stable-fix regression tests.

ensureDom();

const mounted = new Set<() => void>();
let savedConnection: ReturnType<typeof useConnectionStore.getState> | null = null;

/**
 * Call once per test file, before its own hooks: this module is cached across
 * files, so hooks registered at import time would only bind to the first file.
 * Unmounts every rendered page and restores the pristine connection (agent URL,
 * profile, …) so no poller or target leaks into later files.
 */
export function installStableFixHooks(): void {
  beforeEach(() => {
    savedConnection = useConnectionStore.getState();
  });
  afterEach(() => {
    for (const unmount of [...mounted]) unmount();
    if (savedConnection) useConnectionStore.setState(savedConnection, true);
    savedConnection = null;
  });
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function render(element: ReactElement) {
  ensureDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  return { host, unmount };
}

export function button(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text)
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

export function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

export function byName<T extends Element>(host: ParentNode, name: string): T {
  const found = host.querySelector(`[name="${name}"]`);
  if (!found) throw new Error(`Missing control ${name}`);
  return found as unknown as T;
}

/** The control a `<Field label>` is wired to via htmlFor/id. */
export function byLabel(host: ParentNode, label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((entry) =>
    entry.textContent?.startsWith(label)
  );
  const control = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(control instanceof window.HTMLInputElement)) throw new Error(`Missing field ${label}`);
  return control;
}

/** Drive a controlled input/select through React's own onChange prop. */
export function change(element: Element, value: string): void {
  const prototype =
    element instanceof window.HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    // happy-dom's <select> hides React's prop key; React handles its native change.
    if (element instanceof window.HTMLSelectElement) {
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
      return;
    }
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith('__reactProps$')
    );
    const props = key
      ? ((element as unknown as Record<string, unknown>)[key] as {
          onChange?: (event: { target: Element; currentTarget: Element }) => void;
        })
      : undefined;
    if (!props?.onChange) throw new Error('Controlled control has no React onChange handler');
    props.onChange({ target: element, currentTarget: element });
  });
}

/** Fire the Page Visibility event every usePolledData poller refetches on. */
export function refocus(): void {
  act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for UI state');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}
