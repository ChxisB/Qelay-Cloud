import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeBlock } from '../src/components/ui/CodeBlock';
import { ConnectionForm } from '../src/pages/control/gateway/ConnectionForm';
import { ConfigActions } from '../src/pages/control/server/ConfigActions';
import { EnvVarsEditor } from '../src/pages/control/server/EnvVarsEditor';
import { StoragePanel } from '../src/pages/control/server/StoragePanel';
import { ensureDom } from './domSetup';

const mounted: Array<() => void> = [];

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('CodeBlock', () => {
  test('is a named, focusable region, and the caller cannot override that', () => {
    const host = render(createElement(CodeBlock, { label: 'Payload' }, '{"a":1}'));
    const pre = host.querySelector('pre')!;
    expect(pre.getAttribute('role')).toBe('region');
    expect(pre.getAttribute('aria-label')).toBe('Payload');
    expect(pre.tabIndex).toBe(0);
    expect(pre.textContent).toBe('{"a":1}');
  });

  test('the error tone changes the text colour, nothing else', () => {
    const tone = (t: 'default' | 'error') =>
      render(createElement(CodeBlock, { label: 'x', tone: t }, 'x')).querySelector('pre')!
        .className;
    expect(tone('error')).toContain('text-log-err');
    expect(tone('default')).toContain('text-log-fg');
    expect(tone('default')).not.toContain('text-log-err');
  });
});

describe('Server config form', () => {
  test('each env row has a named remove button of at least a hand-sized target', () => {
    const host = render(
      createElement(EnvVarsEditor, { value: { LOG_LEVEL: 'info' }, onChange: () => {} })
    );
    const remove = host.querySelector('button[aria-label="Remove LOG_LEVEL"]')!;
    expect(remove).not.toBeNull();
    expect(remove.className).toContain('size-8');
    expect(host.querySelector('input[aria-label="Variable name LOG_LEVEL"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="Value for LOG_LEVEL"]')).not.toBeNull();
  });

  test('a preset chip adds a row with that key and disappears from the list', () => {
    let latest: Record<string, string> = {};
    const host = render(
      createElement(EnvVarsEditor, { value: {}, onChange: (next) => (latest = next) })
    );
    const chip = () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === '+ LOG_LEVEL');
    act(() => chip()!.click());
    expect(latest).toEqual({ LOG_LEVEL: '' });
    expect(chip()).toBeUndefined();
  });

  test('a save error is an alert and a saved note a status', () => {
    const base = {
      busy: false,
      running: false,
      pending: false,
      conflict: false,
      onSaveAndRestart: () => {},
      onReload: () => {},
    };
    const failed = render(createElement(ConfigActions, { ...base, saved: false, error: 'nope' }));
    expect(failed.querySelector('[role="alert"]')?.textContent).toBe('nope');
    const ok = render(createElement(ConfigActions, { ...base, saved: true, error: null }));
    expect(ok.querySelector('[role="status"]')?.textContent).toBe('Saved');
    expect(ok.querySelector('[role="alert"]')).toBeNull();
  });

  test('an unhealthy disk is announced; a healthy one is not', () => {
    const db = {
      exists: true,
      path: '/data/q.db',
      size: 10,
      walSize: 5,
      shmSize: 1,
      totalSize: 16,
      mtimeMs: 0,
    };
    const bad = render(
      createElement(StoragePanel, { db, disk: { ok: false, message: 'Disk full' } })
    );
    expect(bad.querySelector('[role="alert"]')?.textContent).toContain('Disk full');
    const good = render(createElement(StoragePanel, { db, disk: { ok: true } }));
    expect(good.querySelector('[role="alert"]')).toBeNull();
    expect(good.textContent).toContain('Disk healthy');
  });
});

describe('Connection form', () => {
  const form = () =>
    render(
      createElement(ConnectionForm, {
        onAdd: async () => ({ ok: true }),
        onAccepted: () => {},
        beginAdd: () => null,
        scopeKey: 'k',
      })
    );

  test('the source is a labelled choice, and there are no events to pick', () => {
    const host = form();
    const source = host.querySelector<HTMLSelectElement>('select[name="webhook-source"]')!;
    expect(host.querySelector(`label[for="${source.id}"]`)?.textContent).toContain('Source');
    expect(host.textContent).not.toContain('Events to send');
  });

  test('a bad URL is announced as an alert', async () => {
    const host = form();
    const url = host.querySelector('input[name="webhook-url"]') as HTMLInputElement;
    expect(url).not.toBeNull();
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('p[role="alert"]')).not.toBeNull();
  });
});
