import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { answerConfirms } from './confirmSupport';
import {
  act,
  click,
  createElement,
  DlqConfigForm,
  describe,
  dlqConfig,
  expect,
  findButton,
  installTestHooks,
  json,
  render,
  settle,
  test,
} from './queue-settings.helpers';

installTestHooks();

const serveCaps = (caps: Capabilities) =>
  useCapabilitiesStore.setState({ status: 'ready', caps, error: null, key: 'test' });
const OPERATOR: Capabilities = { ...DEMO_CAPABILITIES, principal: { role: 'operator' } };

// happy-dom does not drive React's change plugin for a controlled input: set the value, then call its onChange prop.
function type(host: HTMLElement, name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const key = Object.getOwnPropertyNames(input).find((k) => k.startsWith('__reactProps$'));
    const props = (input as unknown as Record<string, unknown>)[key ?? ''] as {
      onChange?: (event: { target: typeof input }) => void;
    };
    props.onChange?.({ target: input });
  });
}

/** Records the PUTs and answers `{ ok: true }`. */
function record() {
  const puts: unknown[] = [];
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    puts.push({ method: init?.method, body: JSON.parse(String(init?.body ?? '{}')) });
    return Promise.resolve(json({ ok: true }));
  }) as typeof fetch;
  return puts;
}

const mount = (config = dlqConfig) => {
  const saved = { count: 0 };
  const view = render(
    createElement(DlqConfigForm, {
      queue: 'orders',
      config,
      onSaved: () => {
        saved.count += 1;
      },
    })
  );
  return { ...view, saved };
};

describe('Failed job handling', () => {
  test('a viewer sees the retention as facts: nothing to edit, nothing sent', () => {
    serveCaps({ ...OPERATOR, principal: { role: 'viewer' } });
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error('the DLQ card must not call the server');
    }) as typeof fetch;
    const { host, unmount } = mount();
    expect(host.querySelector('input, select, textarea, [role="switch"]')).toBeNull();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Edit');
    const text = host.textContent ?? '';
    expect(text).toContain('Failed job handling');
    expect(text).toContain('No, they stay in the failed list');
    expect(text).toContain('7 days');
    expect(text).toMatch(/10[.,]000/);
    expect(requests).toBe(0);
    unmount();

    const forever = mount({ ...dlqConfig, maxAge: null });
    expect(forever.host.textContent).toContain('For ever');
  });

  test('an operator reads the sentence first, then edits days and count and saves both', async () => {
    serveCaps(OPERATOR);
    const puts = record();
    const { host, saved } = mount();
    expect(host.textContent).toContain('for 7 days');
    expect(host.querySelector('input')).toBeNull();
    click(host, 'Edit');
    type(host, 'dlq-max-age-days', '14');
    type(host, 'dlq-max-entries', '20000');
    click(host, 'Save');
    await settle(10);
    expect(puts).toEqual([
      { method: 'PUT', body: { config: { maxAge: 14 * 86_400_000, maxEntries: 20_000 } } },
    ]);
    expect(saved.count).toBe(1);
  });

  test('a blank number of days keeps failed jobs for ever', async () => {
    serveCaps(OPERATOR);
    const puts = record();
    const { host } = mount();
    click(host, 'Edit');
    type(host, 'dlq-max-age-days', '');
    click(host, 'Save');
    await settle(10);
    expect(puts).toEqual([
      { method: 'PUT', body: { config: { maxAge: null, maxEntries: 10_000 } } },
    ]);
  });

  test('a limit that deletes failed jobs asks first; a no sends nothing', async () => {
    serveCaps(OPERATOR);
    const puts = record();
    const no = answerConfirms(false);
    const { host } = mount();
    click(host, 'Edit');
    type(host, 'dlq-max-entries', '5');
    click(host, 'Save');
    await settle(10);
    expect(no.questions).toEqual([
      {
        question: 'Delete the failed jobs of "orders" over the new limit?',
        confirmLabel: 'Save and delete',
        danger: true,
      },
    ]);
    expect(puts).toEqual([]);
    no.stop();
  });

  test('raising a limit saves without asking', async () => {
    serveCaps(OPERATOR);
    const puts = record();
    const yes = answerConfirms(true);
    const { host } = mount();
    click(host, 'Edit');
    type(host, 'dlq-max-entries', '10001');
    click(host, 'Save');
    await settle(10);
    expect(yes.questions).toEqual([]);
    expect(puts).toHaveLength(1);
    yes.stop();
  });

  test('nothing to save while the values are unchanged, and a bad value says why', () => {
    serveCaps(OPERATOR);
    const { host } = mount();
    click(host, 'Edit');
    expect(findButton(host, 'Save').disabled).toBe(true);
    type(host, 'dlq-max-entries', '0');
    expect(findButton(host, 'Save').disabled).toBe(true);
    expect(host.textContent).toContain('Keep at least 1 failed job.');
    type(host, 'dlq-max-entries', '10000');
    type(host, 'dlq-max-age-days', '-1');
    expect(host.textContent).toContain('Days must be a number above 0');
  });

  test('a refusal from the server shows in the card and keeps it open', async () => {
    serveCaps(OPERATOR);
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ error: { message: 'maxEntries is too large' } }, 400)
      )) as typeof fetch;
    const { host, saved } = mount();
    click(host, 'Edit');
    type(host, 'dlq-max-entries', '20000');
    click(host, 'Save');
    await settle(10);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('input')).not.toBeNull();
    expect(saved.count).toBe(0);
  });
});
