import type { MouseEvent } from 'react';

// Longest the old picture may be held while the next page loads (a lazy route's first chunk).
const SETTLE_TIMEOUT_MS = 1000;

let release: (() => void) | null = null;
// The newest transition: an older one finishing must not take the name off while this one still needs it.
let latest: unknown = null;

const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const modified = (event: MouseEvent) =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

/**
 * Call from a link's `onClick`, before the router navigates. It asks the browser to hold the old page
 * and cross-move to the new one: `<main>` is named for the pair of snapshots (see motion.css) and the
 * hold ends when the new location has rendered (`settlePageTransition`), or after a second. The click
 * still navigates as usual, and a browser without the API, reduced motion, a modified click or a link
 * to the page already shown does nothing. React Router's `viewTransition` is not used: `BrowserRouter`
 * ignores it, only a data router honours it.
 */
export function startPageTransition(event: MouseEvent, current = false): void {
  const main = document.getElementById('main');
  if (!main || !document.startViewTransition || reduced() || modified(event) || current) return;
  settlePageTransition();
  main.style.setProperty('view-transition-name', 'page');
  // Built before the browser calls back, so a page that renders first is not waited for.
  let done = () => {};
  const rendered = new Promise<void>((resolve) => (done = resolve));
  const timer = setTimeout(done, SETTLE_TIMEOUT_MS);
  release = () => {
    clearTimeout(timer);
    done();
  };
  const transition = document.startViewTransition(() => rendered);
  latest = transition;
  const clear = () => {
    if (latest === transition) main.style.removeProperty('view-transition-name');
  };
  transition.finished.then(clear, clear);
  // A skipped transition (another click, a hidden tab) rejects `ready`; the page still changed.
  transition.ready.catch(() => {});
}

/** The new location has rendered: let the browser take its picture. */
export function settlePageTransition(): void {
  release?.();
  release = null;
}
