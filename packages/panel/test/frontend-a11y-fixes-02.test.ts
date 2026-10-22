import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import {
  act,
  CommandPalette,
  Copilot,
  createElement,
  describe,
  expect,
  installTestHooks,
  MemoryRouter,
  render,
  settle,
  test,
  useCopilotStore,
  waitForElement,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

describe('modal focus and background isolation', () => {
  test('CommandPalette traps Tab, makes siblings inert, and restores focus', async () => {
    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        {},
        createElement(
          'div',
          {},
          createElement('button', { id: 'palette-opener', type: 'button' }, 'Open'),
          createElement(CommandPalette)
        )
      )
    );
    const opener = host.querySelector<HTMLButtonElement>('#palette-opener') as HTMLButtonElement;
    opener.focus();
    act(() => window.dispatchEvent(new window.Event('command-palette:open')));
    await settle(5);

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const input = dialog.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-results');
    const listbox = dialog.querySelector<HTMLElement>('[role="listbox"]');
    const options = dialog.querySelectorAll<HTMLElement>('[role="option"]');
    expect(listbox).not.toBeNull();
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

    act(() =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(opener.inert).toBe(true);
    expect(opener.getAttribute('aria-hidden')).toBe('true');

    const focusables = dialog.querySelectorAll<HTMLElement>('input, button:not([disabled])');
    const last = focusables[focusables.length - 1];
    last.focus();
    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    );
    expect(document.activeElement).toBe(input);

    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    await settle(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(opener.inert).toBe(false);
    expect(opener.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(opener);
    unmount();
  });

  test('Copilot isolates the app and restores focus to its trigger', async () => {
    useCopilotStore.getState().addUser('Conversation that must not be lost accidentally');
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement('button', { id: 'copilot-background', type: 'button' }, 'Background'),
        createElement(Copilot),
        createElement(ConfirmDialog)
      )
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
    act(() => trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const clear = await waitForElement<HTMLButtonElement>(host, '[aria-label="Clear chat"]');
    const background = host.querySelector<HTMLElement>('#copilot-background') as HTMLElement;
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(background.inert).toBe(true);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    // The question is asked in the page, over the panel, which stays where it is.
    const press = (button: Element | null | undefined) =>
      act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const buttonNamed = (name: string) =>
      Array.from(host.querySelectorAll('[role="alertdialog"] button')).find(
        (button) => button.textContent === name
      );
    press(clear);
    await settle(2);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Clear the entire Copilot conversation'
    );
    expect(host.querySelector('[role="dialog"][aria-label="Copilot"]')).not.toBeNull();
    press(buttonNamed('Cancel'));
    await settle(260);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(useCopilotStore.getState().messages).toHaveLength(1);

    press(await waitForElement<HTMLButtonElement>(host, '[aria-label="Clear chat"]'));
    await settle(2);
    press(buttonNamed('Clear chat'));
    await settle(260);
    expect(useCopilotStore.getState().messages).toHaveLength(0);
    expect(host.querySelector('[role="dialog"][aria-label="Copilot"]')).not.toBeNull();

    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    await settle(5);
    const restored = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(restored);
    unmount();
  });
});
