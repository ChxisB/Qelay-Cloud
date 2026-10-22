import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { DlqPro } from '../src/pages/control/DlqPro';
import { Connections } from '../src/pages/control/gateway/Connections';
import { JobsPro } from '../src/pages/control/JobsPro';
import { QueuesOverview } from '../src/pages/control/QueuesOverview';
import { WorkersPro } from '../src/pages/control/WorkersPro';
import { answerConfirms } from './confirmSupport';
import { ensureDom, settle } from './domSetup';

/** The Connections screen inside the router its tabs and links need. */
const ConnectionsPage = () => createElement(MemoryRouter, null, createElement(Connections));

const realFetch = globalThis.fetch;

let stopAnswering = () => {};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`No button with text "${text}"`);
  return button;
}

function clickSameTick(button: HTMLButtonElement, count = 2): void {
  act(() => {
    for (let index = 0; index < count; index++) {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const queueSummary = (name: string, paused = false) => ({
  name,
  paused,
  counts: { waiting: 1, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
});

const dashboardQueue = (name: string, dlq = 0) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});

export type { ReactElement };
export {
  act,
  afterEach,
  beforeEach,
  buttonByText,
  ConnectionsPage,
  clickSameTick,
  createElement,
  createRoot,
  DlqPro,
  dashboardQueue,
  deferred,
  describe,
  ensureDom,
  expect,
  JobsPro,
  json,
  MemoryRouter,
  QueuesOverview,
  queueSummary,
  realFetch,
  render,
  setInput,
  settle,
  test,
  useConnectionStore,
  useToastStore,
  WorkersPro,
};

/** `yesToQuestions`: answer every in-page question yes, as `window.confirm = () => true` once did. Left off, a test answers its own. */
export function installTestHooks({ yesToQuestions = false } = {}) {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server-a.test',
      token: '',
      agentToken: '',
      refreshMs: 60_000,
    });
    useToastStore.setState({ toasts: [] });
    // A question left open by one test must not be the next test's first answer.
    useConfirmStore.setState({ current: null, queue: [] });
    useGlobalModalStore.getState().reset();
    if (yesToQuestions) stopAnswering = answerConfirms().stop;
  });

  afterEach(() => {
    stopAnswering();
    globalThis.fetch = realFetch;
    useConnectionStore.setState({
      baseUrl: '/api',
      token: '',
      agentToken: '',
      refreshMs: 3000,
    });
    useToastStore.setState({ toasts: [] });
  });
}
