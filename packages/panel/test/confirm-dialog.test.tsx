import { afterEach, beforeEach } from 'bun:test';
import { confirmInPage, useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
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
  waitForElement,
} from './frontend-a11y-fixes.helpers';

// The page's own confirm (it replaces window.confirm): what it resolves, how it queues, who owns the screen, and
// where focus goes. The exit takes 180ms (usePresence), so a test that needs it gone waits 260ms.

installTestHooks();

beforeEach(() => {
  useConfirmStore.setState({ current: null, queue: [] });
});

// A question left unanswered at the end of a file must not show up in the next one.
afterEach(() => {
  useConfirmStore.setState({ current: null, queue: [] });
});

const modals = () => useGlobalModalStore.getState();
const SHOWN = '[role="alertdialog"]';
const key = (name: string, init: KeyboardEventInit = {}) =>
  act(() =>
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: name, bubbles: true, ...init })
    )
  );

function mount() {
  const view = render(createElement(ConfirmDialog));
  const buttons = () =>
    Array.from(view.host.querySelectorAll<HTMLButtonElement>(`${SHOWN} button`));
  const named = (name: string) => buttons().find((button) => button.textContent === name);
  const press = (button: Element | null | undefined) =>
    act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const ask = (options: Parameters<typeof confirmInPage>[0]) => {
    let answer = Promise.resolve(false);
    act(() => {
      answer = confirmInPage(options);
    });
    return answer;
  };
  return { ...view, named, press, ask, dialog: () => view.host.querySelector<HTMLElement>(SHOWN) };
}

const ASK = { question: 'Remove destination Ops?', confirmLabel: 'Remove destination' };

describe('the in-page confirm', () => {
  test('resolves true on the main button, named for what it does', async () => {
    const { ask, named, press, dialog } = mount();
    const answer = ask(ASK);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.textContent).toContain('Remove destination Ops?');
    press(named('Remove destination'));
    expect(await answer).toBe(true);
    await settle(260);
    expect(dialog()).toBeNull();
    expect(modals().active).toBeNull();
  });

  test('resolves false on Cancel, on Escape and on the dimmed area', async () => {
    const { ask, named, press, host } = mount();

    let answer = ask(ASK);
    press(named('Cancel'));
    expect(await answer).toBe(false);
    await settle(260);

    answer = ask(ASK);
    key('Escape');
    expect(await answer).toBe(false);
    await settle(260);

    answer = ask(ASK);
    press(host.querySelector('button[aria-label="Cancel"]'));
    expect(await answer).toBe(false);
  });

  test('a danger question draws its main button as the danger variant', () => {
    const { ask, named } = mount();
    void ask({ ...ASK, danger: true });
    expect(named('Remove destination')?.className).not.toBe(named('Cancel')?.className);
  });

  test('two questions queue: one on screen at a time, the shell held between them', async () => {
    const { ask, named, press, host } = mount();
    const first = ask({ ...ASK, question: 'First?' });
    const second = ask({ ...ASK, question: 'Second?' });
    expect(host.querySelectorAll(SHOWN)).toHaveLength(1);
    expect(host.querySelector(SHOWN)?.textContent).toContain('First?');

    press(named('Cancel'));
    expect(await first).toBe(false);
    await settle(5);
    expect(host.querySelectorAll(SHOWN)).toHaveLength(1);
    expect(host.querySelector(SHOWN)?.textContent).toContain('Second?');
    expect(modals().active).toBe('confirm');

    press(named('Remove destination'));
    expect(await second).toBe(true);
    expect(modals().active).toBeNull();
  });

  test('focus starts on Cancel, Tab stays inside, and focus returns to the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { ask, named, press, dialog } = mount();
    const answer = ask(ASK);
    expect(document.activeElement).toBe(named('Cancel'));

    named('Remove destination')?.focus();
    key('Tab');
    expect(document.activeElement).toBe(named('Cancel'));
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(named('Remove destination'));
    expect(dialog()?.contains(document.activeElement)).toBe(true);

    press(named('Cancel'));
    await answer;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test('a queued question gives focus back to the first opener, not to a button that went away', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { ask, named, press } = mount();
    const first = ask(ASK);
    const second = ask({ ...ASK, question: 'Remove destination Billing?' });
    press(named('Cancel'));
    await first;
    press(named('Cancel'));
    await second;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test('a typed word keeps the main button off until it matches, and focus starts on the field', async () => {
    const { ask, named, press, host } = mount();
    const answer = ask({ ...ASK, typedWord: 'Ops' });
    const field = host.querySelector<HTMLInputElement>(`${SHOWN} input`) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(named('Remove destination')?.disabled).toBe(true);

    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'Ops'
      );
      const props = (field as unknown as Record<string, { onChange: (e: unknown) => void }>)[
        Object.getOwnPropertyNames(field).find((k) => k.startsWith('__reactProps$')) as string
      ];
      props.onChange({ target: field, currentTarget: field });
    });
    expect(named('Remove destination')?.disabled).toBe(false);
    press(named('Remove destination'));
    expect(await answer).toBe(true);
  });

  test('is above the palette, and replaces it', async () => {
    const view = render(
      createElement(MemoryRouter, null, createElement(CommandPalette), createElement(ConfirmDialog))
    );
    act(() => window.dispatchEvent(new window.Event('command-palette:open')));
    await settle(5);
    expect(modals().active).toBe('command-palette');

    let answer = Promise.resolve(false);
    act(() => {
      answer = confirmInPage(ASK);
    });
    expect(modals().active).toBe('confirm');
    expect(view.host.querySelector(SHOWN)).not.toBeNull();
    key('Escape');
    expect(await answer).toBe(false);
    expect(modals().active).toBeNull();
  });
});

describe('the in-page confirm and sign-in', () => {
  test('is refused while sign-in is up: the answer is false and nothing opens', async () => {
    const { ask, dialog } = mount();
    act(() => {
      modals().request('authentication');
    });
    expect(await ask(ASK)).toBe(false);
    expect(dialog()).toBeNull();
    expect(modals().active).toBe('authentication');
  });

  test('sign-in taking the screen cancels an open question and hides it at once', async () => {
    const { ask, dialog } = mount();
    const answer = ask(ASK);
    expect(dialog()).not.toBeNull();
    act(() => {
      modals().request('authentication');
    });
    expect(dialog()).toBeNull();
    expect(await answer).toBe(false);
    expect(useConfirmStore.getState().current).toBeNull();
  });
});

describe('the in-page confirm over a panel that stays', () => {
  test('hands the shell back to Copilot and leaves it open', async () => {
    const view = render(
      createElement('div', null, createElement(Copilot), createElement(ConfirmDialog))
    );
    act(() =>
      view.host
        .querySelector('[aria-label="Open Copilot"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    );
    await waitForElement(view.host, '[role="dialog"][aria-label="Copilot"]');
    expect(modals().active).toBe('copilot');

    let answer = Promise.resolve(false);
    act(() => {
      answer = confirmInPage(ASK);
    });
    expect(modals().active).toBe('confirm');
    expect(modals().beneath).toBe('copilot');
    // Escape belongs to the question alone: the panel behind it stays open.
    key('Escape');
    expect(await answer).toBe(false);
    expect(modals().active).toBe('copilot');
    expect(view.host.querySelector('[role="dialog"][aria-label="Copilot"]')).not.toBeNull();
  });

  test('hands the shell back to the database drawer, and not to one that went away first', async () => {
    modals().request('database-row');
    const answer = confirmInPage(ASK);
    expect(modals().active).toBe('confirm');
    expect(modals().beneath).toBe('database-row');
    useConfirmStore.getState().answer(useConfirmStore.getState().current?.id ?? -1, true);
    expect(await answer).toBe(true);
    expect(modals().active).toBe('database-row');

    const second = confirmInPage(ASK);
    modals().release('database-row');
    useConfirmStore.getState().answer(useConfirmStore.getState().current?.id ?? -1, true);
    expect(await second).toBe(true);
    expect(modals().active).toBeNull();
  });

  test('replaces any other owner, as every owner does', () => {
    modals().request('mobile-navigation');
    void confirmInPage(ASK);
    expect(modals().active).toBe('confirm');
    expect(modals().beneath).toBeNull();
  });
});

describe('the in-page confirm leaving', () => {
  test('plays the 180ms exit, with the buttons out of reach, then unmounts', async () => {
    const { ask, named, press, dialog } = mount();
    const answer = ask(ASK);
    press(named('Cancel'));
    await answer;
    // Leaving: still drawn, no longer answering a click, and the shell is already free.
    expect(dialog()).not.toBeNull();
    expect(dialog()?.className).toContain('motion-leave');
    expect(dialog()?.parentElement?.className).toContain('pointer-events-none');
    expect(dialog()?.parentElement?.hasAttribute('inert')).toBe(true);
    expect(modals().active).toBeNull();
    await settle(260);
    expect(dialog()).toBeNull();
  });

  test('is gone at once under reduced motion', async () => {
    const real = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      const { ask, named, press, dialog } = mount();
      const answer = ask(ASK);
      press(named('Cancel'));
      await answer;
      expect(dialog()).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
