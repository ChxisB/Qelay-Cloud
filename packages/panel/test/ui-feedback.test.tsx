import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { Banner, type BannerTone } from '../src/components/ui/Banner';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '../src/components/ui/feedback';
import { Toaster } from '../src/components/ui/Toaster';
import { ensureDom, settle } from './domSetup';

const CSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const mounted: Array<() => void> = [];
const restorers: Array<() => void> = [];

function render(element: ReactElement) {
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

function click(el: Element | null | undefined) {
  act(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

const byText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  restorers.push(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
}

beforeEach(() => ensureDom());

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  for (const restore of restorers.splice(0)) restore();
  useToastStore.setState({ toasts: [] });
});

describe('LoadingState', () => {
  test('is a busy status whose skeleton is decorative and still under reduced motion', () => {
    const host = render(createElement(LoadingState, { label: 'Loading jobs…' }));
    const status = host.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.textContent).toBe('Loading jobs…');
    const skeleton = host.querySelector('[aria-hidden="true"]');
    expect(skeleton?.querySelectorAll('span').length).toBeGreaterThan(4);
    // Every pulse is `motion-safe:`, so none runs when the OS asks for reduced motion.
    const classes = [...host.querySelectorAll('span')].flatMap((s) => [...s.classList]);
    expect(classes).toContain('motion-safe:animate-pulse');
    expect(classes).not.toContain('animate-pulse');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('EmptyState', () => {
  test('puts the icon in a round badge above the title, hint and actions', () => {
    const host = render(
      createElement(EmptyState, {
        icon: createElement('svg'),
        title: 'No jobs',
        hint: 'Add one.',
        action: createElement('button', {}, 'Add'),
      })
    );
    const badge = host.querySelector('[aria-hidden="true"]');
    expect(badge?.classList.contains('rounded-full')).toBe(true);
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(host.textContent).toBe('No jobsAdd one.Add');
  });

  test('draws no badge without an icon', () => {
    expect(
      render(createElement(EmptyState, { title: 'None' })).querySelector('[aria-hidden]')
    ).toBeNull();
  });
});

describe('ErrorState', () => {
  test('names the failure, shows the message and keeps Retry inside the alert', () => {
    let retried = 0;
    const host = render(
      createElement(ErrorState, {
        error: new Error('503 upstream'),
        title: 'Jobs could not be loaded',
        onRetry: () => retried++,
      })
    );
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Jobs could not be loaded');
    expect(alert?.textContent).toContain('503 upstream');
    click(byText(alert!, 'Retry'));
    expect(retried).toBe(1);
  });

  test('Copy details copies the message, status and code, and never the error details', async () => {
    const copied: string[] = [];
    stubClipboard(async (text) => void copied.push(text));
    const error = Object.assign(new Error('upstream unavailable'), {
      status: 503,
      code: 'upstream_unavailable',
      details: { authorization: 'Bearer SECRET-TOKEN' },
    });
    const host = render(createElement(ErrorState, { error }));
    click(byText(host, 'Copy details'));
    await act(() => settle(1));
    expect(copied).toEqual(['upstream unavailable\nstatus 503\ncode upstream_unavailable']);
    expect(copied.join()).not.toContain('SECRET-TOKEN');
    expect(byText(host, 'Copied')).toBeDefined();
  });

  test('says so when the copy failed', async () => {
    stubClipboard(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    restorers.push(() => Reflect.deleteProperty(document, 'execCommand'));
    const host = render(createElement(ErrorState, { error: new Error('x') }));
    click(byText(host, 'Copy details'));
    await act(() => settle(1));
    expect(byText(host, 'Copy failed')).toBeDefined();
  });
});

describe('OfflineBanner', () => {
  test('is a polite strip with the glyph, the word, the message and Retry', () => {
    let retried = 0;
    const host = render(
      createElement(OfflineBanner, { message: 'Refresh failed', onRetry: () => retried++ })
    );
    const strip = host.querySelector('[role="status"]');
    expect(strip?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(strip?.textContent).toContain('Disconnected');
    expect(strip?.textContent).toContain('Refresh failed');
    click(byText(host, 'Retry'));
    expect(retried).toBe(1);
  });
});

describe('Banner', () => {
  const roles: Array<[BannerTone, string]> = [
    ['problem', 'alert'],
    ['warn', 'status'],
    ['info', 'status'],
    ['ok', 'status'],
  ];

  test.each(roles)('%s is announced as %s and keeps its title in words', (tone, role) => {
    const host = render(
      createElement(
        Banner,
        { tone, title: 'Heads up', action: createElement('button', {}, 'Go') },
        'Detail.'
      )
    );
    const banner = host.firstElementChild;
    expect(banner?.getAttribute('role')).toBe(role);
    expect(banner?.textContent).toBe('Heads upDetail.Go');
  });

  test('defaults to the problem tone', () => {
    expect(
      render(createElement(Banner, { title: 'Broken' })).firstElementChild?.getAttribute('role')
    ).toBe('alert');
  });
});

describe('Toaster', () => {
  test('an error is an alert, the others are statuses, each with a glyph and a word', () => {
    useToastStore.setState({
      toasts: [
        { id: 1, level: 'error', title: 'Failed', detail: 'Try later', ttlMs: 60_000 },
        { id: 2, level: 'success', title: 'Saved', ttlMs: 60_000 },
        { id: 3, level: 'info', title: 'FYI', ttlMs: 60_000 },
      ],
    });
    const host = render(createElement(Toaster));
    const alerts = host.querySelectorAll('[role="alert"]');
    const statuses = host.querySelectorAll('[role="status"]');
    expect(alerts).toHaveLength(1);
    expect(statuses).toHaveLength(2);
    const [error, success, info] = [alerts[0], statuses[0], statuses[1]];
    expect(error?.textContent).toContain('Failed');
    expect(error?.textContent).toContain('Try later');
    expect(success?.textContent).toBe('Saved');
    expect(info?.textContent).toBe('FYI');
    for (const toast of [error, success, info]) {
      expect(toast?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
  });

  test('Dismiss removes the toast', () => {
    useToastStore.setState({ toasts: [{ id: 1, level: 'info', title: 'FYI', ttlMs: 60_000 }] });
    const host = render(createElement(Toaster));
    click(host.querySelector('button[aria-label="Dismiss notification"]'));
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
