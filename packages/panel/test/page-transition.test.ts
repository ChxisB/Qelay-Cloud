import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MouseEvent } from 'react';
import { settlePageTransition, startPageTransition } from '../src/lib/pageTransition';
import './domSetup';

// The browser's view-transition API does not exist in happy-dom, so a fake stands in for it and the
// test checks what the helper asks of it: when it asks, what it names, and when it lets go.

const click = (extra: Partial<MouseEvent> = {}) =>
  ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  }) as MouseEvent;

type Doc = { startViewTransition?: unknown };
const doc = () => document as unknown as Doc;
const realMatchMedia = window.matchMedia;
const realSetTimeout = globalThis.setTimeout;

let main: HTMLElement;
let calls: number;
let held: Promise<void> | undefined;
let finish: () => void;
let finishes: Array<() => void>;

beforeEach(() => {
  main = document.createElement('main');
  main.id = 'main';
  document.body.appendChild(main);
  calls = 0;
  finishes = [];
  held = undefined;
  doc().startViewTransition = (update: () => Promise<void>) => {
    calls += 1;
    // The browser takes its old picture, then calls back on a later turn.
    queueMicrotask(() => (held = update()));
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
      finishes.push(resolve);
    });
    return { finished, ready: Promise.reject(new Error('skipped')) };
  };
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  settlePageTransition();
  main.remove();
  delete doc().startViewTransition;
  window.matchMedia = realMatchMedia;
  globalThis.setTimeout = realSetTimeout;
});

const pending = async (promise: Promise<void> | undefined) =>
  (await Promise.race([promise, Promise.resolve('waiting')])) === 'waiting';

describe('startPageTransition', () => {
  test('names <main> and starts one transition for a plain click', () => {
    startPageTransition(click());
    expect(calls).toBe(1);
    expect(main.style.getPropertyValue('view-transition-name')).toBe('page');
  });

  test.each([
    ['a browser without the API', () => delete doc().startViewTransition, click(), false],
    [
      'reduced motion',
      () => (window.matchMedia = (() => ({ matches: true })) as never),
      click(),
      false,
    ],
    ['a modified click', () => {}, click({ metaKey: true }), false],
    ['a middle click', () => {}, click({ button: 1 }), false],
    ['a link to the page already shown', () => {}, click(), true],
  ])('does nothing for %s', (_name, arrange, event, current) => {
    arrange();
    startPageTransition(event, current);
    expect(calls).toBe(0);
    expect(main.style.getPropertyValue('view-transition-name')).toBe('');
  });

  test('does nothing when there is no <main>', () => {
    main.remove();
    startPageTransition(click());
    expect(calls).toBe(0);
  });

  test('holds the old picture until the new location has rendered', async () => {
    startPageTransition(click());
    await Promise.resolve();
    expect(await pending(held)).toBe(true);
    settlePageTransition();
    expect(await pending(held)).toBe(false);
  });

  test('a page that rendered before the browser called back is not waited for', async () => {
    startPageTransition(click());
    settlePageTransition();
    await Promise.resolve();
    expect(await pending(held)).toBe(false);
  });

  test('lets go after a second even if nothing settles it', async () => {
    let timer: (() => void) | undefined;
    let delay = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timer = fn;
      delay = ms;
      return 0;
    }) as unknown as typeof setTimeout;
    startPageTransition(click());
    await Promise.resolve();
    expect(delay).toBe(1000);
    expect(await pending(held)).toBe(true);
    timer?.();
    expect(await pending(held)).toBe(false);
  });

  test('takes the name off <main> when the transition has finished', async () => {
    startPageTransition(click());
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(main.style.getPropertyValue('view-transition-name')).toBe('');
  });

  test('a second click settles the first before it starts its own', async () => {
    startPageTransition(click());
    await Promise.resolve();
    const first = held;
    startPageTransition(click());
    expect(calls).toBe(2);
    expect(await pending(first)).toBe(false);
  });

  test('the first click finishing does not take the name off while the second still uses it', async () => {
    startPageTransition(click());
    startPageTransition(click());
    finishes[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(main.style.getPropertyValue('view-transition-name')).toBe('page');
    finishes[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(main.style.getPropertyValue('view-transition-name')).toBe('');
  });
});
