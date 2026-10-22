import { StrictMode, useState } from 'react';
import { useRevealFocus } from '../src/components/ui/useRevealFocus';
import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  render,
  test,
} from './frontend-a11y-fixes.helpers';

// Opening moves focus into the section, closing gives it back to the button, and mounting does neither, also in
// StrictMode (which runs every effect twice in development).

installTestHooks();

function Section({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const { toggle, body } = useRevealFocus(open);
  return createElement(
    'div',
    null,
    createElement('button', { ref: toggle, onClick: () => setOpen(!open) }, 'Toggle'),
    createElement(
      'div',
      { ref: body },
      open ? createElement('input', { 'aria-label': 'First' }) : null
    )
  );
}

const mount = (startOpen: boolean) => {
  const view = render(createElement(StrictMode, null, createElement(Section, { startOpen })));
  const toggle = view.host.querySelector('button')!;
  return { ...view, toggle };
};

describe('useRevealFocus', () => {
  test('mounting closed takes no focus, also under StrictMode', () => {
    const { toggle } = mount(false);
    expect(document.activeElement).not.toBe(toggle);
  });

  test('mounting open takes no focus either', () => {
    const { host } = mount(true);
    expect(document.activeElement).not.toBe(host.querySelector('input'));
  });

  test('opening focuses the first control, and closing gives focus back to the button', () => {
    const { host, toggle } = mount(false);
    act(() => toggle.click());
    expect(document.activeElement).toBe(host.querySelector('input'));
    act(() => toggle.click());
    expect(document.activeElement).toBe(toggle);
  });
});
