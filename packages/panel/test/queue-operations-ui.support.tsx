import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueueOperationsPanel } from '../src/features/queue-operations/ui/QueueOperationsPanel';

export const mounted = new Set<() => void>();

export function panel(properties: Parameters<typeof QueueOperationsPanel>[0]) {
  return createElement(MemoryRouter, null, createElement(QueueOperationsPanel, properties));
}

export function render(element: ReturnType<typeof createElement>) {
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
  return {
    host,
    unmount,
    rerender: (next: ReturnType<typeof createElement>) => act(() => root.render(next)),
  };
}

export function input(host: HTMLElement, name: string): HTMLInputElement {
  const found = host.querySelector(`[name="${name}"]`);
  if (!(found instanceof window.HTMLInputElement)) throw new Error(`Missing input ${name}`);
  return found;
}

export function setValue(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    const propsKey = Object.getOwnPropertyNames(element).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((element as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: element, currentTarget: element });
  });
}

export function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text)
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

export function click(host: HTMLElement, text: string): void {
  act(() => button(host, text).click());
}
