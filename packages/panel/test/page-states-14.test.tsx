import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthGate } from '../src/components/AuthGate';
import { ConfigErrorScreen, SignInScreen } from '../src/components/AuthScreens';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { setActiveSession } from '../src/lib/auth/activeSession';
import { useAuthStore } from '../src/lib/auth/authStore';
import type { OidcSession } from '../src/lib/auth/oidc';
import { NotAvailable, OperatorOnly } from '../src/pages/NotAvailable';
import { NotFound } from '../src/pages/NotFound';
import { ensureDom, settle } from './domSetup';

const mounted: Array<() => void> = [];

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

const h1 = (host: HTMLElement) => host.querySelector('h1')?.textContent;
const hrefs = (host: HTMLElement) =>
  [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  setActiveSession(null);
  useAuthStore.setState({ status: 'ready', subject: null, managed: false, error: null });
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('page states', () => {
  test('404 is one h1, a decorative number, and two ways out', () => {
    const host = render(createElement(NotFound));
    expect(h1(host)).toBe('That page does not exist');
    expect(host.querySelector('[aria-hidden="true"]')?.textContent).toBe('404');
    expect(hrefs(host)).toEqual(['/', '/queues']);
  });

  test('a closed page names itself, and an operator-only page says what role is needed', () => {
    const closed = render(createElement(NotAvailable, { name: 'Server control' }));
    expect(h1(closed)).toBe('Not available in this deployment');
    expect(closed.textContent).toContain('Server control is not part of this deployment');
    expect(hrefs(closed)).toEqual(['/']);
    expect(h1(render(createElement(OperatorOnly)))).toBe('Operator role needed');
  });

  test('a crashed page is an alert with the message and a Retry, and the app does not unmount', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('render exploded');
    };
    const host = render(createElement(ErrorBoundary, {}, createElement(Boom)));
    spy.mockRestore();
    expect(h1(host)).toBe('Something went wrong');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('render exploded');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Retry',
      'Copy details',
    ]);
  });
});

describe('sign-in screens', () => {
  test('redirecting says so politely and offers no action', () => {
    useAuthStore.setState({ status: 'redirecting', managed: true });
    const host = render(createElement(SignInScreen));
    expect(h1(host)).toBe('Signing you in');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('identity provider');
    expect(host.querySelector('button')).toBeNull();
  });

  test('signed out has one Sign in button that starts a new sign-in, and says where the token lives', () => {
    let started = 0;
    setActiveSession({ signInAgain: () => void started++ } as unknown as OidcSession);
    useAuthStore.setState({ status: 'signed-out', managed: true });
    const host = render(createElement(SignInScreen));
    expect(h1(host)).toBe('You are signed out');
    expect(host.textContent).toContain('stays in memory for this tab');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Sign in']);
    act(() => buttons[0]!.click());
    expect(started).toBe(1);
  });

  test('a failed sign-in is an alert with the reason, and says nothing about token storage', () => {
    useAuthStore.setState({ status: 'error', managed: true, error: 'access_denied' });
    const host = render(createElement(SignInScreen));
    expect(h1(host)).toBe('Sign-in problem');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('access_denied');
    expect(host.textContent).not.toContain('memory');
    expect(host.querySelector('button')?.textContent).toBe('Sign in again');
  });

  test('a config error is an alert with the message and points at config.json', () => {
    const host = render(createElement(ConfigErrorScreen, { message: 'auth.issuer is missing' }));
    expect(h1(host)).toBe('The panel is not configured correctly');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('auth.issuer is missing');
    expect(host.querySelector('span.font-mono')?.textContent).toBe('config.json');
    expect(host.querySelector('main')).not.toBeNull();
  });
});

describe('token gate', () => {
  test('the token field has a visible label, and the dialog is described by its reason', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server.test/api', token: '' });
    const host = render(createElement(AuthGate));
    act(() =>
      window.dispatchEvent(
        new window.CustomEvent('auth:required', {
          detail: { scope: 'server', auth: undefined, target: 'https://server.test/api' },
        })
      )
    );
    await settle(5);
    const dialog = host.querySelector('[role="dialog"]')!;
    const label = dialog.querySelector('label')!;
    expect(label.textContent).toBe('Bearer token');
    expect(dialog.querySelector('input')?.id).toBe(label.htmlFor);
    const reason = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toContain('https://server.test/api');
  });
});
