import { describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { BackupPolicy } from '../src/lib/ops/types';
import { Backups } from '../src/pages/control/Backups';
import { settle } from './domSetup';
import { installOpsHooks, mountRouted, serveRole } from './ops.helpers';

installOpsHooks();

const policy = (patch: Partial<BackupPolicy> = {}): BackupPolicy => ({
  mechanism: 'external',
  tool: 'pgBackRest',
  location: 'gs://acme-backups/prod',
  updatedBy: 'ops',
  updatedAt: Date.now() - 3 * 3_600_000,
  ...patch,
});

/** Serves `GET /backup-policy` from `held` and records each `PUT` body; a PUT answers `reject` when given. */
function serve(held: BackupPolicy | null, reject?: string) {
  const puts: unknown[] = [];
  let current = held;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Response.json({ ok: true, data: { policy: current } });
    puts.push(JSON.parse(String(init.body)));
    if (reject) {
      return Response.json(
        { ok: false, error: { code: 'invalid_request', message: reject } },
        { status: 400 }
      );
    }
    current = { ...policy(), ...(puts.at(-1) as Partial<BackupPolicy>) };
    return Response.json({ ok: true, data: { policy: current } });
  }) as typeof fetch;
  return puts;
}

async function show() {
  const page = mountRouted(createElement(Backups), '/backups');
  await settle(80);
  return page;
}

const radio = (host: HTMLElement, value: string) =>
  host.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
const save = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save declaration'))!;
const field = (host: HTMLElement, placeholder: string) =>
  host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;

const click = (element: HTMLElement) =>
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

/** happy-dom does not drive React's change plugin for a controlled input: set the value, then call its onChange prop. */
function type(input: HTMLInputElement, value: string) {
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

describe('the Backups page', () => {
  test('nobody has said: a warning, nothing chosen, nothing to save yet', async () => {
    serve(null);
    const page = await show();
    expect(page.text()).toContain('Not declared.');
    for (const value of ['provider', 'external', 'none']) {
      expect(radio(page.host, value).checked).toBe(false);
    }
    expect(save(page.host).disabled).toBe(true);
    page.unmount();
  });

  test('the operator’s own tooling is named, with where the copies land and who said so', async () => {
    serve(policy());
    const page = await show();
    expect(page.text()).toContain('pgBackRest, copies at gs://acme-backups/prod.');
    expect(page.text()).toContain('Declared by ops 3h ago.');
    expect(radio(page.host, 'external').checked).toBe(true);
    expect(field(page.host, 'pgBackRest').value).toBe('pgBackRest');
    page.unmount();
  });

  test('the provider’s backups are an answer, "none" is a warning', async () => {
    serve(policy({ mechanism: 'provider', tool: null, location: null }));
    const provider = await show();
    expect(provider.text()).toContain("The database service's own backups.");
    provider.unmount();

    serve(policy({ mechanism: 'none', tool: null, location: null }));
    const none = await show();
    expect(none.text()).toContain('Declared as not backed up.');
    none.unmount();
  });

  test('an operator picks their own tooling, must name it, and the save sends exactly that', async () => {
    const puts = serve(null);
    const page = await show();
    click(radio(page.host, 'external'));
    expect(save(page.host).disabled).toBe(true);

    type(field(page.host, 'pgBackRest'), '  Barman ');
    type(field(page.host, 'gs://acme-backups/prod'), '');
    expect(save(page.host).disabled).toBe(false);
    click(save(page.host));
    await settle(80);

    expect(puts).toEqual([{ mechanism: 'external', tool: 'Barman', location: null }]);
    expect(page.text()).toContain('Barman');
    page.unmount();
  });

  test('"provider" and "none" send no tool and no location', async () => {
    const puts = serve(policy());
    const page = await show();
    click(radio(page.host, 'provider'));
    click(save(page.host));
    await settle(80);
    expect(puts).toEqual([{ mechanism: 'provider' }]);
    page.unmount();
  });

  test('a tool the server would refuse is caught before the request', async () => {
    const puts = serve(policy());
    const page = await show();
    type(field(page.host, 'pgBackRest'), 'x'.repeat(201));
    expect(page.text()).toContain('At most 200 characters.');
    expect(save(page.host).disabled).toBe(true);
    type(field(page.host, 'pgBackRest'), '');
    expect(page.text()).toContain('Name the tool that takes the backups.');
    expect(puts).toEqual([]);
    page.unmount();
  });

  test('a refused save keeps the draft and says why', async () => {
    serve(null, 'The declaration does not fit.');
    const page = await show();
    click(radio(page.host, 'none'));
    click(save(page.host));
    await settle(80);
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain(
      'The declaration does not fit.'
    );
    expect(radio(page.host, 'none').checked).toBe(true);
    page.unmount();
  });

  test('a viewer reads the answer and cannot change it', async () => {
    serveRole('viewer');
    serve(policy());
    const page = await show();
    expect(page.text()).toContain('pgBackRest');
    expect(page.text()).toContain('Only an operator can change this.');
    expect(page.host.querySelector('fieldset')?.disabled).toBe(true);
    expect(field(page.host, 'pgBackRest').disabled).toBe(true);
    expect(
      [...page.host.querySelectorAll('button')].some((b) => b.textContent?.includes('Save'))
    ).toBe(false);
    page.unmount();
  });
});
