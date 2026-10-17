import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/layout/AppLayout';
import { ensureDom, settle } from './domSetup';

describe('Copilot switched off', () => {
  test('the app shell mounts no Copilot unless the build opts in', async () => {
    ensureDom();
    const previousFlag = process.env.VITE_ENABLE_COPILOT;
    delete process.env.VITE_ENABLE_COPILOT;
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              Routes,
              {},
              createElement(
                Route,
                { path: '/', element: createElement(AppLayout) },
                createElement(Route, { index: true, element: createElement('h1', {}, 'Page') })
              )
            )
          )
        )
      );
      await settle(3);
      expect(host.querySelector('[aria-label="Open Copilot"]')).toBeNull();
      expect(host.querySelector('#copilot-layer')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      window.matchMedia = previousMatchMedia;
      if (previousFlag !== undefined) process.env.VITE_ENABLE_COPILOT = previousFlag;
    }
  });

  test('keeps the Copilot statically removable from default builds', () => {
    const shell = readFileSync(
      new URL('../src/components/copilot/Copilot.tsx', import.meta.url),
      'utf8'
    );
    // The pure annotation is what lets the default build drop the panel chunk.
    expect(shell).toContain('/* @__PURE__ */ retryableLazy(');
    const layout = readFileSync(
      new URL('../src/components/layout/AppLayout.tsx', import.meta.url),
      'utf8'
    );
    expect(layout).toContain("import.meta.env.VITE_ENABLE_COPILOT === '1' &&");
  });
});
