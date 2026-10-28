import { afterEach, beforeEach } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { type Capabilities, DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import type { DeploymentView, TransportQueue, TransportView } from '../src/lib/ops/types';
import { ensureDom } from './domSetup';

/** Builders for the three ops responses, healthy by default; a test overrides what it is about. */

const NOW = 1_800_000_000_000;

export function deployment(patch: Partial<DeploymentView> = {}): DeploymentView {
  return {
    version: '1.0.0',
    commit: 'a1b2c3d',
    production: true,
    devToken: false,
    schema: { current: 5, expected: 5, state: 'current' },
    database: { state: 'ok', latencyMs: 3 },
    transport: { name: 'gcp-pubsub', state: 'ok' },
    connections: { inUse: 12, maxConnections: 100, needed: 40, mode: 'direct' },
    tick: {
      state: 'ok',
      lastSuccessAt: NOW - 4_000,
      lastFailureAt: null,
      ageMs: 4_000,
      lateAfterMs: 60_000,
      staleAfterMs: 300_000,
    },
    workers: { total: 4, active: 3 },
    doorbells: { notRung: 0, oldestNotRungAgeMs: null, queuesScanned: 2, partial: false },
    warnings: [],
    timestamp: NOW,
    ...patch,
  };
}

export function queue(
  name: string,
  patch: Partial<Omit<TransportQueue, 'store'>> & { store?: Partial<TransportQueue['store']> } = {}
): TransportQueue {
  const { store, ...rest } = patch;
  return {
    queue: name,
    doorbellDepth: 0,
    inFlight: null,
    delayed: null,
    oldestUndeliveredAgeMs: null,
    deadLetterDepth: 0,
    deadLetterOldestAgeMs: null,
    freshness: {
      observedAt: NOW - 45_000,
      ageMs: 45_000,
      maxStalenessMs: 300_000,
      source: 'cloud-monitoring',
    },
    store: {
      queue: name,
      claimable: 0,
      notRung: 0,
      reRingDue: 0,
      oldestNotRungAgeMs: null,
      paused: false,
      windowClosed: false,
      capped: false,
      ...store,
    },
    ...rest,
  };
}

export function transport(
  queues: TransportQueue[],
  patch: Partial<TransportView> = {}
): TransportView {
  return {
    transport: {
      name: 'gcp-pubsub',
      maxDeliverDelayMs: 0,
      ordering: 'none',
      approximateCounts: false,
    },
    deadLetter: { supported: true },
    queues,
    truncated: false,
    timestamp: NOW,
    ...patch,
  };
}

const OPERATOR: Capabilities = { ...DEMO_CAPABILITIES, principal: { role: 'operator' } };
const VIEWER: Capabilities = { ...DEMO_CAPABILITIES, principal: { role: 'viewer' } };

export function serveRole(role: 'operator' | 'viewer'): void {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: role === 'operator' ? OPERATOR : VIEWER,
    error: null,
    key: 'test',
  });
}

export function mountRouted(element: ReactElement, path = '/') {
  ensureDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, element)));
  return {
    host,
    text: () => host.textContent ?? '',
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const realFetch = globalThis.fetch;

/**
 * Serves JSON for the ops endpoints and records every request path. `routes` maps a path prefix
 * to a body or to a status/body pair; anything else is a 500 so a stray request fails the test.
 */
export function serveOps(routes: Record<string, unknown | { status: number; body: unknown }>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    seen.push(path);
    // The longest prefix wins, so `/transport/dead-letters` is not answered by `/transport`.
    const match = Object.keys(routes)
      .filter((prefix) => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (match === undefined)
      return Response.json({ error: { code: 'unexpected' } }, { status: 500 });
    const route = routes[match] as { status?: number; body?: unknown };
    if (route && typeof route === 'object' && 'status' in route && 'body' in route) {
      return Response.json(route.body, { status: route.status });
    }
    return Response.json(routes[match]);
  }) as typeof fetch;
  return seen;
}

export function installOpsHooks(): void {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server.test',
      token: '',
      agentToken: '',
      refreshMs: 1_000,
    });
    serveRole('operator');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3_000 });
  });
}
