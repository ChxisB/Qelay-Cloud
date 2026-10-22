import {
  createElement,
  DlqConfigForm,
  describe,
  dlqConfig,
  expect,
  installTestHooks,
  render,
  test,
} from './queue-settings.helpers';

installTestHooks();

describe('Queue config validation and save lifecycle', () => {
  test('the DLQ policy is shown as facts: nothing to edit, nothing to save, nothing sent', () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error('the DLQ card must not call the server');
    }) as typeof fetch;
    const view = render(createElement(DlqConfigForm, { config: dlqConfig }));
    expect(view.host.querySelector('input, select, textarea, [role="switch"]')).toBeNull();
    const labels = Array.from(view.host.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Save');
    const text = view.host.textContent ?? '';
    expect(text).toContain('Failed job handling');
    expect(text).toContain('No, they stay in the failed list');
    expect(text).toContain('7 days');
    expect(text).toMatch(/10[.,]000/);
    // The reasons stay in the page, one click away.
    expect(text).toContain('read-only');
    expect(requests).toBe(0);
    view.unmount();

    const on = render(createElement(DlqConfigForm, { config: { ...dlqConfig, autoRetry: true } }));
    expect(on.host.textContent).toContain('On');
    const forever = render(
      createElement(DlqConfigForm, { config: { ...dlqConfig, maxAge: null } })
    );
    expect(forever.host.textContent).toContain('For ever');
  });
});
