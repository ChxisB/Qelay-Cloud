import { beforeEach } from 'bun:test';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import {
  act,
  CommandPalette,
  createElement,
  describe,
  expect,
  installTestHooks,
  MemoryRouter,
  render,
  settle,
  test,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

beforeEach(() => {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 't',
  });
});

async function open() {
  const { host } = render(createElement(MemoryRouter, null, createElement(CommandPalette)));
  act(() => window.dispatchEvent(new window.Event('command-palette:open')));
  await settle(5);
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
  const input = dialog.querySelector<HTMLInputElement>('input') as HTMLInputElement;
  // React reads a controlled input through its own onChange, which happy-dom does not fire.
  const type = async (text: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        text
      );
      const key = Object.getOwnPropertyNames(input).find((k) => k.startsWith('__reactProps$'));
      const props = (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[
        key as string
      ];
      props.onChange({ target: input, currentTarget: input });
    });
    await settle(2);
  };
  return { dialog, input, type };
}

describe('command palette groups', () => {
  test('lists Pages then Actions, with one flat option index across the groups', async () => {
    const { dialog, input } = await open();
    const groups = [...dialog.querySelectorAll('[role="group"]')].map((g) =>
      g.getAttribute('aria-label')
    );
    expect(groups).toEqual(['Pages', 'Actions']);
    const options = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.id)).toEqual(
      options.map((_, index) => `command-palette-option-${index}`)
    );
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  });

  test('shows the result count, and narrows it as you type', async () => {
    const { dialog, type } = await open();
    const all = dialog.querySelectorAll('[role="option"]').length;
    expect(dialog.textContent).toContain(`${all} results`);
    await type('dead letter');
    expect(dialog.querySelectorAll('[role="option"]').length).toBeLessThan(all);
    expect(dialog.textContent).toContain('Dead letter queue');
  });

  test('says "Nothing matches" and keeps no option selected when nothing fits', async () => {
    const { dialog, input, type } = await open();
    await type('zzzz-no-such-thing');
    expect(dialog.querySelectorAll('[role="option"]').length).toBe(0);
    expect(dialog.textContent).toContain('Nothing matches');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
});
