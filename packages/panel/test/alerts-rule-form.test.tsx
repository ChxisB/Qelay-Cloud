import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RuleForm } from '../src/pages/Alerts';
import { ensureDom } from './domSetup';

const mounted = new Set<() => void>();

beforeEach(() => ensureDom());

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
});

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label)
  );
  if (!button) throw new Error(`No button matching "${label}"`);
  return button;
}

function clickTwice(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  act(() => {
    const prototype =
      element.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    if (element.tagName === 'SELECT') {
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
      return;
    }
    const propsKey = Object.getOwnPropertyNames(element).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((element as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: typeof element; currentTarget: typeof element }) => void;
        })
      : null;
    if (!props?.onChange)
      throw new Error(`Control ${element.getAttribute('name')} has no onChange`);
    props.onChange({ target: element, currentTarget: element });
  });
}

function input(host: HTMLElement, name: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!element) throw new Error(`No input named ${name}`);
  return element;
}

describe('Alerts same-tick safety', () => {
  test('double Save rule in one tick invokes the add callback once', () => {
    const added: unknown[] = [];
    const { host } = render(
      createElement(RuleForm, {
        onAdd: (rule) => {
          added.push(rule);
          return { ok: true };
        },
      })
    );
    setValue(input(host, 'alert-rule-name'), 'High error rate');
    setValue(input(host, 'alert-rule-threshold'), '5');

    clickTwice(findButton(host, 'Save rule'));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'High error rate',
      metric: 'error_rate',
      operator: '>=',
      threshold: 5,
      queue: '',
      enabled: true,
    });
  });
});
