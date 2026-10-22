import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthGate } from '../src/components/AuthGate';
import { ConfigErrorScreen, SignInScreen } from '../src/components/AuthScreens';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { useAuthStore } from '../src/lib/auth/authStore';
import { ensureDom, settle } from './domSetup';

// The sign-in card rises once and its text fades in again when the screen changes under it. The token lock pops in,
// leaves over 180 ms, and is as strict as before: no Escape, no click outside, no close mark.

const SERVER = 'https://server.test/api';
const mounted: Array<() => void> = [];
const realMatchMedia = window.matchMedia;

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, {}, element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

function lock(host: HTMLElement) {
  act(() =>
    window.dispatchEvent(
      new window.CustomEvent('auth:required', { detail: { scope: 'server', target: SERVER } })
    )
  );
  const form = host.querySelector<HTMLFormElement>('[role="dialog"]');
  if (!form) throw new Error('The token lock did not open');
  return form;
}

const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    input.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: value }));
  });

const unlock = (host: HTMLElement) => {
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error('Unlock button not found');
  return button;
};

beforeEach(() => {
  ensureDom();
  useGlobalModalStore.getState().reset();
  useConnectionStore.setState({ baseUrl: SERVER, token: '', agentToken: '' });
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  window.matchMedia = realMatchMedia;
  useGlobalModalStore.getState().reset();
  useAuthStore.setState({ status: 'ready', subject: null, managed: false, error: null });
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('sign-in screens', () => {
  test('the card rises once, and its text fades in again when the screen changes', () => {
    useAuthStore.setState({ status: 'redirecting', managed: true });
    const host = render(createElement(SignInScreen));
    const card = host.querySelector('section')!;
    const text = card.querySelector('h1')!.parentElement!;
    expect(card.className).toContain('motion-arrive');
    expect(text.className).toContain('motion-fade');

    act(() => useAuthStore.setState({ status: 'signed-out' }));
    expect(host.querySelector('section')).toBe(card);
    expect(card.querySelector('h1')?.textContent).toBe('You are signed out');
    // A new element, so the fade plays again; the card itself is not replayed.
    expect(card.querySelector('h1')!.parentElement).not.toBe(text);
  });

  test('a config error takes the same card', () => {
    const host = render(createElement(ConfigErrorScreen, { message: 'auth.issuer is missing' }));
    expect(host.querySelector('section')?.className).toContain('motion-arrive');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('auth.issuer is missing');
  });
});

describe('token lock', () => {
  test('pops in over its own scrim and does not replay while the token is typed', async () => {
    const host = render(createElement(AuthGate));
    const form = lock(host);
    const scrim = host.querySelector('[aria-hidden="true"].bg-scrim')!;
    expect(form.className).toContain('motion-pop');
    expect(scrim.className).toContain('motion-fade');
    expect(scrim.className).not.toContain('motion-fade-out');

    await settle(20);
    const input = form.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    for (const text of ['a', 'ab', 'abc']) type(input, text);
    expect(host.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="dialog"]')).toBe(form);
    expect(form.className).toContain('motion-pop');
  });

  test('cannot be dismissed: no Escape, no click outside, no close mark, and Unlock waits for text', async () => {
    const host = render(createElement(AuthGate));
    const form = lock(host);
    await settle(20);

    act(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      host
        .querySelector('.bg-scrim')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle(260);
    expect(host.querySelector('[role="dialog"]')).toBe(form);
    expect(form.className).not.toContain('motion-leave');
    expect(host.querySelector('.bg-scrim')?.closest('button')).toBeNull();

    expect([...form.querySelectorAll('button, a')].map((el) => el.textContent?.trim())).toEqual([
      'Open Settings instead',
      'Unlock',
    ]);
    expect(unlock(host).disabled).toBe(true);
    type(form.querySelector('input')!, '   ');
    expect(unlock(host).disabled).toBe(true);
    type(form.querySelector('input')!, 'secret');
    expect(unlock(host).disabled).toBe(false);
  });

  test('unlocking saves the token, then the lock leaves over 180 ms and cannot be used meanwhile', async () => {
    const host = render(createElement(AuthGate));
    const form = lock(host);
    type(form.querySelector('input')!, 'secret');
    act(() => unlock(host).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

    expect(useConnectionStore.getState().token).toBe('secret');
    expect(host.querySelector('[role="dialog"]')).toBe(form);
    expect(form.className).toContain('motion-leave');
    expect(host.querySelector('.bg-scrim')?.className).toContain('motion-fade-out');
    expect(form.parentElement?.hasAttribute('inert')).toBe(true);

    await settle(260);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  test('under reduced motion it opens and closes at once', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const host = render(createElement(AuthGate));
    const form = lock(host);
    type(form.querySelector('input')!, 'secret');
    act(() => unlock(host).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
