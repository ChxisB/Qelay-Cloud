import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { CreateCard } from '../src/components/ui/CreateCard';
import { button, click, renderUi } from './control-dom.helpers';
import './domSetup';

function Harness({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <CreateCard
      title="Create schedule"
      button="New schedule"
      open={open}
      onOpenChange={setOpen}
      empty={empty}
    >
      <input aria-label="Name" />
      <button type="button" onClick={() => setOpen(false)}>
        Create
      </button>
    </CreateCard>
  );
}

const mounted: Array<() => void> = [];
function show(empty?: boolean) {
  const ui = renderUi(<Harness empty={empty} />);
  mounted.push(ui.unmount);
  return ui;
}
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('create card', () => {
  test('keeps the form out of the page until the button is pressed', () => {
    const { host } = show();
    expect(host.querySelector('input')).toBeNull();
    const open = button(host, 'New schedule');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    click(open);
    expect(document.activeElement).toBe(host.querySelector('input'));
    click(button(host, 'Cancel'));
    expect(host.querySelector('input')).toBeNull();
    expect(document.activeElement?.textContent).toBe('New schedule');
  });

  test('the caller can close it, as after a create', () => {
    const { host } = show();
    click(button(host, 'New schedule'));
    click(button(host, 'Create'));
    expect(host.querySelector('input')).toBeNull();
  });

  test('shows the form with no button while the list is empty, and does not steal focus', () => {
    const { host } = show(true);
    expect(host.querySelector('input')).not.toBeNull();
    expect(host.textContent).not.toContain('New schedule');
    expect(host.textContent).not.toContain('Cancel');
    expect(document.activeElement).not.toBe(host.querySelector('input'));
  });
});
