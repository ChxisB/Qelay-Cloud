import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { ReadFirstCard, Value } from '../src/components/ui/ReadFirstCard';
import { button, click, renderUi } from './control-dom.helpers';
import './domSetup';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <ReadFirstCard
      title="Speed limit"
      sub="Cap how many jobs run."
      summary={
        <>
          Up to <Value>100</Value> jobs a minute.
        </>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <input aria-label="Jobs allowed" />
      <button type="button" onClick={() => setOpen(false)}>
        Apply
      </button>
    </ReadFirstCard>
  );
}

const mounted: Array<() => void> = [];
function show() {
  const ui = renderUi(<Harness />);
  mounted.push(ui.unmount);
  return ui;
}
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('read-first card', () => {
  test('says what is set and keeps the fields out of the page until Edit', () => {
    const { host } = show();
    expect(host.textContent).toContain('Up to 100 jobs a minute.');
    expect(host.querySelector('strong')?.textContent).toBe('100');
    expect(host.querySelector('input')).toBeNull();
    const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit speed limit"]')!;
    expect(edit.textContent).toBe('Edit');
    expect(edit.getAttribute('aria-expanded')).toBe('false');
  });

  test('Edit opens the fields and moves focus into them; Cancel closes and returns focus', () => {
    const { host } = show();
    click(host.querySelector<HTMLButtonElement>('button[aria-label="Edit speed limit"]')!);
    const input = host.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    expect(button(host, 'Cancel').getAttribute('aria-label')).toBe('Cancel editing speed limit');
    click(button(host, 'Cancel'));
    expect(host.querySelector('input')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit speed limit');
  });

  test('the caller can close the card, as after a save', () => {
    const { host } = show();
    click(button(host, 'Edit'));
    click(button(host, 'Apply'));
    expect(host.querySelector('input')).toBeNull();
  });
});
