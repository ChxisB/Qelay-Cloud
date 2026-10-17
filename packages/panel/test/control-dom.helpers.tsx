import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

export { createElement };

/** Render `element` into the document. `unmount` is safe to call more than once. */
export function renderUi(element: ReactElement): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      if (!active) return;
      active = false;
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** A promise settled from outside: holds a request open until the test lets it go. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function button(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text)
  );
  if (!found) throw new Error(`Missing button containing ${text}`);
  return found;
}

/** The input, select or textarea named `label` (by `aria-label`). */
export function field<T extends HTMLElement = HTMLInputElement>(
  host: ParentNode,
  label: string
): T {
  const found = host.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing control ${label}`);
  return found;
}

export function click(control: HTMLElement): void {
  act(() => control.click());
}

/**
 * Type into a controlled input the way a user does. happy-dom does not turn a native `input` event into
 * React's `onChange`, so the handler is called through the element's React props, after the value is set
 * with the prototype setter (which keeps React's own value tracking honest).
 */
export function changeControl(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const view = control.ownerDocument.defaultView;
  if (!view) throw new Error('The control is not in a document');
  const prototype =
    control.tagName === 'TEXTAREA'
      ? view.HTMLTextAreaElement.prototype
      : control.tagName === 'SELECT'
        ? view.HTMLSelectElement.prototype
        : view.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
    if (control.tagName === 'SELECT') {
      control.dispatchEvent(new view.Event('change', { bubbles: true }));
      return;
    }
    const key = Object.getOwnPropertyNames(control).find((name) =>
      name.startsWith('__reactProps$')
    );
    const props = key
      ? ((control as unknown as Record<string, unknown>)[key] as {
          onChange?: (event: { target: Element; currentTarget: Element }) => void;
        })
      : undefined;
    if (!props?.onChange) throw new Error('Controlled control has no React onChange handler');
    props.onChange({ target: control, currentTarget: control });
  });
}
