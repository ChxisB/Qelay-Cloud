import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Field, Input, Select, Textarea, Toggle } from '../src/components/ui/form';
import { ensureDom } from './domSetup';

const mounted: Array<() => void> = [];

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host };
}

function click(el: Element | null | undefined) {
  act(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

beforeEach(() => ensureDom());

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('Toggle', () => {
  test('is a switch that reports its state and flips on click', () => {
    const seen: boolean[] = [];
    const { host } = render(
      createElement(Toggle, {
        checked: false,
        onChange: (v: boolean) => seen.push(v),
        label: 'Enabled',
      })
    );
    const toggle = host.querySelector('button') as HTMLButtonElement;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Enabled');
    click(toggle);
    expect(seen).toEqual([true]);
  });

  test('the target is 36x24, the on track is --ok and the thumb moves right', () => {
    const off = render(createElement(Toggle, { checked: false, onChange: () => {}, label: 'A' }));
    const on = render(createElement(Toggle, { checked: true, onChange: () => {}, label: 'B' }));
    const button = off.host.querySelector('button') as HTMLButtonElement;
    expect(button.classList.contains('h-6')).toBe(true);
    expect(button.classList.contains('w-9')).toBe(true);
    const [offTrack, offThumb] = Array.from(off.host.querySelectorAll('button > span'));
    const [onTrack, onThumb] = Array.from(on.host.querySelectorAll('button > span'));
    expect(offTrack?.classList.contains('bg-line-strong')).toBe(true);
    expect(onTrack?.classList.contains('bg-ok')).toBe(true);
    // The thumb sits 2px in and slides 16px by transform, so it still ends at 18px.
    expect(offThumb?.classList.contains('left-0.5')).toBe(true);
    expect(offThumb?.classList.contains('translate-x-0')).toBe(true);
    expect(onThumb?.classList.contains('left-0.5')).toBe(true);
    expect(onThumb?.classList.contains('translate-x-4')).toBe(true);
    expect(onThumb?.classList.contains('bg-on-ok')).toBe(true);
  });

  test('disabled blocks the change', () => {
    const seen: boolean[] = [];
    const { host } = render(
      createElement(Toggle, {
        checked: true,
        disabled: true,
        onChange: (v: boolean) => seen.push(v),
        label: 'A',
      })
    );
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    expect(seen).toEqual([]);
  });
});

describe('Input and Select', () => {
  test('are 32px fields with the field-line border and the 6px radius', () => {
    for (const element of [
      createElement(Input),
      createElement(Select, {}, createElement('option')),
    ]) {
      const { host } = render(element);
      const cls = (host.firstElementChild as HTMLElement).classList;
      expect(cls.contains('min-h-8')).toBe(true);
      expect(cls.contains('border-line-strong')).toBe(true);
      expect(cls.contains('rounded-control')).toBe(true);
      expect(cls.contains('aria-invalid:border-bad')).toBe(true);
    }
  });
});

describe('Field', () => {
  test('without an error the control is not marked invalid', () => {
    const { host } = render(
      createElement(Field, { label: 'Name', hint: 'Shown in the list' }, createElement(Input))
    );
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBeNull();
    const hint = host.querySelector('p') as HTMLElement;
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(host.querySelector('label')?.getAttribute('for')).toBe(input.id);
  });

  test('an error marks the control invalid and describes it, after the hint', () => {
    const { host } = render(
      createElement(
        Field,
        { label: 'Name', hint: 'Shown in the list', error: 'Name is required' },
        createElement(Input)
      )
    );
    const input = host.querySelector('input') as HTMLInputElement;
    const [hint, error] = Array.from(host.querySelectorAll('p'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`${hint?.id} ${error?.id}`);
    expect(error?.textContent).toBe('Name is required');
    expect(error?.classList.contains('text-danger')).toBe(true);
  });

  test('a control that brings its own aria-describedby keeps it and still gets the error', () => {
    const { host } = render(
      createElement(
        Field,
        { label: 'Name', error: 'Bad' },
        createElement(Input, { 'aria-describedby': 'mine' })
      )
    );
    const error = host.querySelector('p') as HTMLElement;
    expect(host.querySelector('input')?.getAttribute('aria-describedby')).toBe(`mine ${error.id}`);
  });

  test('a Textarea child is labelled like an Input (axe "label" on the Cron page)', () => {
    const { host } = render(createElement(Field, { label: 'Data' }, createElement(Textarea)));
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.id).not.toBe('');
    expect(host.querySelector('label')?.getAttribute('for')).toBe(area.id);
  });
});
