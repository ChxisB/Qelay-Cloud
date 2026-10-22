import { describe, expect, test } from 'bun:test';
import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { App } from '../src/App';
import { LegacyRedirect } from '../src/components/LegacyRedirect';
import { ensureDom } from './domSetup';

const MOVED = [
  ['/overview-classic', '/'],
  ['/queues-classic', '/queues'],
  ['/queues-classic/:name', '/queues/:name'],
  ['/jobs-classic', '/jobs'],
  ['/dlq-classic', '/dlq'],
  ['/cron-classic', '/cron'],
  ['/metrics-classic', '/metrics'],
  ['/workers-classic', '/workers'],
  ['/logs-classic', '/logs'],
  ['/usage-classic', '/usage'],
  ['/s3-classic', '/s3'],
] as const;

function childrenOf(node: ReactElement): ReactElement[] {
  const children = (node.props as { children?: ReactNode }).children;
  return (Array.isArray(children) ? children : [children]).filter(isValidElement);
}

function Where() {
  const { pathname, search, hash } = useLocation();
  return createElement('p', { id: 'where' }, `${pathname}${search}${hash}`);
}

function landed(from: string): string {
  ensureDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [from] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '*', element: createElement(LegacyRedirect) }),
          createElement(Route, { path: '/queues/*', element: createElement(Where) }),
          createElement(Route, { path: '/', element: createElement(Where) }),
          createElement(Route, { path: '/usage', element: createElement(Where) })
        )
      )
    )
  );
  const text = host.querySelector('#where')?.textContent ?? '';
  act(() => root.unmount());
  host.remove();
  return text;
}

describe('the removed classic pages', () => {
  test('every old path is still registered and goes to the redirect', () => {
    const layout = childrenOf(App())[0];
    if (!layout) throw new Error('Layout route missing');
    const routes = childrenOf(layout);
    for (const [from] of MOVED) {
      const route = routes.find((r) => (r.props as { path?: string }).path === from);
      expect((route?.props as { element?: ReactElement } | undefined)?.element?.type, from).toBe(
        LegacyRedirect
      );
    }
  });

  test('each one lands on the page without the suffix, keeping the query string and the hash', () => {
    expect(landed('/overview-classic?range=1h')).toBe('/?range=1h');
    expect(landed('/queues-classic/email%20jobs?tab=jobs#top')).toBe(
      '/queues/email%20jobs?tab=jobs#top'
    );
    expect(landed('/Queues-Classic/Email')).toBe('/Queues/Email');
    expect(landed('/usage-classic/')).toBe('/usage/');
  });
});
